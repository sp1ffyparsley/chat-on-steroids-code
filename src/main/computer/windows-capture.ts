/**
 * Source-owned Windows.Graphics.Capture backend. Compiled by the persistent Windows
 * PowerShell helper against Windows' installed WinMetadata, with no SDK/native binary
 * dependency. The capture is tied to one HWND and never activates that window.
 */
export const WINDOWS_CAPTURE_SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

public static class CosWindowsCapture {
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }
  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IGraphicsCaptureItemInterop {
    [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
    [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
  }
  // Query the optional WinRT interface instead of compiling against a newer
  // WinMetadata property: supported Windows 10 hosts may not declare it yet.
  [ComImport, Guid("F2CDD966-22AE-5EA1-9596-3A289344C3BE"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  interface IGraphicsCaptureSession3 {
    bool IsBorderRequired {
      [return: MarshalAs(UnmanagedType.U1)] get;
      [param: MarshalAs(UnmanagedType.U1)] set;
    }
  }
  [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string value, int length, out IntPtr result);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
  [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint levelCount, uint version, out IntPtr device, out int level, out IntPtr context);
  [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT value);

  const int TimeoutMs = 3000;
  const long MaxPixels = 32000000;

  static void Check(int result) { Marshal.ThrowExceptionForHR(result); }
  static void Release(ref IntPtr value) { if (value != IntPtr.Zero) { Marshal.Release(value); value = IntPtr.Zero; } }

  static RECT CaptureBounds(IntPtr window, int width, int height, string phase) {
    if (!IsWindow(window) || IsIconic(window)) throw new InvalidOperationException("CAPTURE_FAILED: target window is closed or minimized");
    RECT dwm, outer;
    int dwmResult = DwmGetWindowAttribute(window, 9, out dwm, Marshal.SizeOf(typeof(RECT)));
    bool hasOuter = GetWindowRect(window, out outer);
    if (dwmResult >= 0 && width == dwm.Right - dwm.Left && height == dwm.Bottom - dwm.Top) return dwm;
    // WGC differs by Windows/app chrome: some items exclude invisible resize borders and
    // match DWMWA_EXTENDED_FRAME_BOUNDS; others include them and match GetWindowRect. Select
    // only an exact physical-pixel match, so screenshot coordinates are never guessed.
    if (hasOuter && width == outer.Right - outer.Left && height == outer.Bottom - outer.Top) return outer;
    string dwmSize = dwmResult >= 0 ? (dwm.Right - dwm.Left) + "x" + (dwm.Bottom - dwm.Top) : "unavailable";
    string outerSize = hasOuter ? (outer.Right - outer.Left) + "x" + (outer.Bottom - outer.Top) : "unavailable";
    throw new InvalidOperationException("STALE_FRAME: capture geometry matches neither DWM nor outer bounds (phase=" + phase + ", hwnd=" + window.ToInt64() + ", capture=" + width + "x" + height + ", dwm=" + dwmSize + ", outer=" + outerSize + ")");
  }

  static GraphicsCaptureItem CreateItem(IntPtr window) {
    IntPtr name = IntPtr.Zero, factory = IntPtr.Zero, item = IntPtr.Zero;
    object interopObject = null;
    try {
      string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
      Check(WindowsCreateString(className, className.Length, out name));
      Guid interopId = typeof(IGraphicsCaptureItemInterop).GUID;
      Check(RoGetActivationFactory(name, ref interopId, out factory));
      interopObject = Marshal.GetObjectForIUnknown(factory);
      Guid itemId = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
      int result = ((IGraphicsCaptureItemInterop)interopObject).CreateForWindow(window, ref itemId, out item);
      if (result < 0) throw new InvalidOperationException(
        "CAPTURE_FAILED: target window does not expose a Windows.Graphics.Capture surface (HRESULT 0x" + result.ToString("X8") + ")");
      return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(item);
    } finally {
      Release(ref item);
      if (interopObject != null && Marshal.IsComObject(interopObject)) Marshal.ReleaseComObject(interopObject);
      Release(ref factory);
      if (name != IntPtr.Zero) WindowsDeleteString(name);
    }
  }

  static IDirect3DDevice CreateDevice() {
    IntPtr device = IntPtr.Zero, context = IntPtr.Zero, dxgi = IntPtr.Zero, projected = IntPtr.Zero;
    try {
      int level;
      // BGRA support is required by Windows.Graphics.Capture and SoftwareBitmap.
      Check(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
      Guid dxgiId = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
      Check(Marshal.QueryInterface(device, ref dxgiId, out dxgi));
      Check(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out projected));
      return (IDirect3DDevice)Marshal.GetObjectForIUnknown(projected);
    } finally { Release(ref projected); Release(ref dxgi); Release(ref context); Release(ref device); }
  }

  static SoftwareBitmap CopySurface(IDirect3DSurface surface, Stopwatch clock) {
    var operation = SoftwareBitmap.CreateCopyFromSurfaceAsync(surface, BitmapAlphaMode.Ignore);
    try {
      // Poll the WinRT completion state: no UI dispatcher or managed continuation is
      // needed on the persistent helper's STA thread.
      while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
        if (clock.ElapsedMilliseconds >= TimeoutMs) {
          operation.Cancel();
          throw new TimeoutException("CAPTURE_FAILED: GPU readback timed out");
        }
        Thread.Sleep(5);
      }
      return operation.GetResults();
    } finally { operation.Close(); }
  }

  static void ValidateCaptureSize(IntPtr window, int width, int height) {
    if (width <= 0 || height <= 0 || (long)width * height > MaxPixels)
      throw new InvalidOperationException("CAPTURE_FAILED: capture dimensions exceed the pixel limit (hwnd=" +
        window.ToInt64() + ", width=" + width + ", height=" + height + ", maxPixels=" + MaxPixels + ")");
  }

  public static string Capture(long handle, int maxWidth, string file) {
    if (!GraphicsCaptureSession.IsSupported()) throw new NotSupportedException("CAPTURE_FAILED: Windows.Graphics.Capture is unavailable");
    IntPtr window = new IntPtr(handle);
    if (!IsWindow(window) || IsIconic(window)) throw new InvalidOperationException("CAPTURE_FAILED: target window is closed or minimized");
    var clock = Stopwatch.StartNew();
    var item = CreateItem(window);
    int width = item.Size.Width, height = item.Size.Height;
    ValidateCaptureSize(window, width, height);
    RECT bounds = CaptureBounds(window, width, height, "item");
    using (var device = CreateDevice())
    using (var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, item.Size))
    using (var session = pool.CreateCaptureSession(item)) {
      // One-shot tool screenshots must not flash Windows' yellow capture border.
      // Configure before StartCapture; older Windows keeps its system indicator.
      var border = (object)session as IGraphicsCaptureSession3;
      if (border != null) border.IsBorderRequired = false;
      session.StartCapture();
      Direct3D11CaptureFrame frame = null;
      while (frame == null) {
        if (clock.ElapsedMilliseconds >= TimeoutMs) throw new TimeoutException("CAPTURE_FAILED: no Windows.Graphics.Capture frame arrived");
        frame = pool.TryGetNextFrame();
        if (frame == null) Thread.Sleep(5);
      }
      using (frame) {
        RECT after = CaptureBounds(window, width, height, "after-frame");
        if (after.Left != bounds.Left || after.Top != bounds.Top || after.Right != bounds.Right || after.Bottom != bounds.Bottom)
          throw new InvalidOperationException("STALE_FRAME: window bounds changed during capture (phase=after-frame, hwnd=" + window.ToInt64() + ", before=" + bounds.Left + "," + bounds.Top + "," + width + "x" + height + "; after=" + after.Left + "," + after.Top + "," + (after.Right - after.Left) + "x" + (after.Bottom - after.Top) + ")");
        // GraphicsCaptureItem.Size can include the invisible resize border while the received
        // frame marks only its DWM content as valid. ContentSize is not a resize race when it
        // exactly matches another live Windows geometry authority; crop the unused pool tail.
        int contentWidth = frame.ContentSize.Width, contentHeight = frame.ContentSize.Height;
        if (contentWidth <= 0 || contentHeight <= 0 || contentWidth > width || contentHeight > height)
          throw new InvalidOperationException("STALE_FRAME: capture returned invalid content dimensions (phase=content, hwnd=" + window.ToInt64() + ", item=" + width + "x" + height + ", frame=" + contentWidth + "x" + contentHeight + ")");
        RECT contentBounds = CaptureBounds(window, contentWidth, contentHeight, "content");
        using (var surface = frame.Surface)
        using (var software = CopySurface(surface, clock)) {
          if (software.PixelWidth != width || software.PixelHeight != height) throw new InvalidOperationException("STALE_FRAME: copied surface dimensions changed (phase=readback, hwnd=" + window.ToInt64() + ")");
          byte[] pixels = new byte[checked(width * height * 4)];
          var pixelBuffer = new Windows.Storage.Streams.Buffer((uint)pixels.Length);
          software.CopyToBuffer(pixelBuffer);
          using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(pixelBuffer)) reader.ReadBytes(pixels);
          using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            var locked = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try { Marshal.Copy(pixels, 0, locked.Scan0, pixels.Length); }
            finally { bitmap.UnlockBits(locked); }
            Bitmap content = bitmap, cropped = null;
            try {
              if (contentWidth != width || contentHeight != height) {
                cropped = bitmap.Clone(new Rectangle(0, 0, contentWidth, contentHeight), PixelFormat.Format32bppArgb);
                content = cropped;
              }
              int outputWidth = maxWidth > 0 ? Math.Min(maxWidth, contentWidth) : contentWidth;
              int outputHeight = Math.Max(1, (int)Math.Round((double)contentHeight * outputWidth / contentWidth));
              if (outputWidth == contentWidth) content.Save(file, ImageFormat.Png);
              else using (var scaled = new Bitmap(outputWidth, outputHeight))
              using (var graphics = Graphics.FromImage(scaled)) {
                graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(content, new Rectangle(0, 0, outputWidth, outputHeight));
                scaled.Save(file, ImageFormat.Png);
              }
              return contentBounds.Left + "," + contentBounds.Top + "," + contentWidth + "," + contentHeight + "," + outputWidth + "," + outputHeight;
            } finally {
              if (cropped != null) cropped.Dispose();
            }
          }
        }
      }
    }
  }
}
`;

/** Compiles on first window capture so other desktop operations remain independent. */
export const WINDOWS_CAPTURE_BOOTSTRAP = String.raw`
function Initialize-WindowsCapture {
if ('CosWindowsCapture' -as [type]) { return }
$captureRuntime = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$captureReferences = @('System.dll', 'System.Core.dll', 'System.Runtime.dll', 'System.Runtime.WindowsRuntime.dll', 'System.Drawing.dll') | ForEach-Object { Join-Path $captureRuntime $_ }
$captureReferences += Get-ChildItem -LiteralPath (Join-Path $env:windir 'System32\WinMetadata') -Filter '*.winmd' | ForEach-Object { $_.FullName }
# Add-Type tries to load WinMD files as CLR assemblies before compilation. Invoke
# the same Framework compiler through CodeDOM to preserve their WinRT metadata.
$captureCompiler = New-Object Microsoft.CSharp.CSharpCodeProvider
try {
$captureParameters = New-Object System.CodeDom.Compiler.CompilerParameters
$captureParameters.GenerateInMemory = $true
$captureParameters.ReferencedAssemblies.AddRange([string[]]$captureReferences)
$captureCompiled = $captureCompiler.CompileAssemblyFromSource($captureParameters, [string[]]@(@'
${WINDOWS_CAPTURE_SOURCE}
'@))
if ($captureCompiled.Errors.HasErrors) {
  throw ('CAPTURE_FAILED: Windows capture compilation failed: ' + (($captureCompiled.Errors | ForEach-Object { $_.ErrorText }) -join '; '))
}
$null = $captureCompiled.CompiledAssembly
} finally { $captureCompiler.Dispose() }
}
`;
