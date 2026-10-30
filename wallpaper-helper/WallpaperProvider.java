package com.pandaeats.bench.wallpaper;

import android.app.WallpaperManager;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Point;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.view.WindowManager;
import java.io.*;
import org.json.JSONObject;

/** USB-only bridge. No launcher, network, receivers or background services. */
public final class WallpaperProvider extends ContentProvider {
    public boolean onCreate() { return true; }
    private void checkCaller() {
        int uid = Binder.getCallingUid();
        if (uid != 2000 && uid != android.os.Process.myUid())
            throw new SecurityException("Only the USB shell can use this helper");
    }
    private File file(String name) {
        if (!name.matches("input\\.png|home\\.png|lock\\.png|snapshot\\.json"))
            throw new IllegalArgumentException("Unknown file");
        return new File(getContext().getFilesDir(), name);
    }
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        checkCaller();
        return ParcelFileDescriptor.open(file(uri.getLastPathSegment()),
            mode.contains("w") ? ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_WRITE_ONLY
                              : ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public synchronized Bundle call(String method, String arg, Bundle extras) {
        checkCaller();
        long identity = Binder.clearCallingIdentity();
        Bundle answer = new Bundle();
        try {
            WallpaperManager wm = WallpaperManager.getInstance(getContext());
            if (!method.equals("clean") && (!wm.isWallpaperSupported() || !wm.isSetWallpaperAllowed()))
                throw new SecurityException("Wallpaper changes are blocked on this tablet");
            JSONObject result;
            if (method.equals("snapshot")) {
                if (wm.getWallpaperInfo() != null || (android.os.Build.VERSION.SDK_INT >= 34 && wm.getWallpaperInfo(WallpaperManager.FLAG_LOCK) != null))
                    throw new IOException("A live wallpaper needs manual backup");
                result = new JSONObject();
                result.put("home", save(wm, WallpaperManager.FLAG_SYSTEM, "home.png"));
                result.put("lock", save(wm, WallpaperManager.FLAG_LOCK, "lock.png"));
                try (FileOutputStream out = new FileOutputStream(file("snapshot.json"))) {
                    out.write(result.toString().getBytes("UTF-8"));
                }
            } else if (method.equals("set")) {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(file("input.png").getPath(), bounds);
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("This is not a readable image");
                Point screen = new Point();
                ((WindowManager)getContext().getSystemService("window")).getDefaultDisplay().getRealSize(screen);
                BitmapFactory.Options options = new BitmapFactory.Options();
                while (bounds.outWidth / (options.inSampleSize == 0 ? 2 : options.inSampleSize * 2) >= screen.x &&
                       bounds.outHeight / (options.inSampleSize == 0 ? 2 : options.inSampleSize * 2) >= screen.y)
                    options.inSampleSize = options.inSampleSize == 0 ? 2 : options.inSampleSize * 2;
                Bitmap source = BitmapFactory.decodeFile(file("input.png").getPath(), options);
                if (source == null) throw new IOException("Could not decode the image");
                Bitmap cropped = Bitmap.createBitmap(screen.x, screen.y, Bitmap.Config.ARGB_8888);
                Canvas canvas = new Canvas(cropped);
                float scale = Math.max((float)screen.x / source.getWidth(), (float)screen.y / source.getHeight());
                canvas.translate((screen.x - source.getWidth() * scale) / 2, (screen.y - source.getHeight() * scale) / 2);
                canvas.scale(scale, scale);
                canvas.drawBitmap(source, 0, 0, new Paint(Paint.FILTER_BITMAP_FLAG));
                // Separate calls create explicit home AND lock records, both verifiable in dumpsys.
                int home = wm.setBitmap(cropped, new Rect(0, 0, screen.x, screen.y), false, WallpaperManager.FLAG_SYSTEM);
                int lock = wm.setBitmap(cropped, new Rect(0, 0, screen.x, screen.y), false, WallpaperManager.FLAG_LOCK);
                source.recycle(); cropped.recycle();
                result = new JSONObject().put("homeId", home).put("lockId", lock).put("width", screen.x).put("height", screen.y);
            } else if (method.equals("restore")) {
                JSONObject saved;
                try (FileInputStream in = new FileInputStream(file("snapshot.json"))) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(); copy(in, out);
                    saved = new JSONObject(out.toString("UTF-8"));
                }
                restore(wm, WallpaperManager.FLAG_SYSTEM, "home.png", saved.getBoolean("home"));
                restore(wm, WallpaperManager.FLAG_LOCK, "lock.png", saved.getBoolean("lock"));
                result = new JSONObject().put("homeId", wm.getWallpaperId(WallpaperManager.FLAG_SYSTEM))
                    .put("lockId", wm.getWallpaperId(WallpaperManager.FLAG_LOCK));
            } else if (method.equals("clean")) {
                for (String name : new String[]{"input.png", "home.png", "lock.png", "snapshot.json"}) file(name).delete();
                result = new JSONObject();
            } else throw new IllegalArgumentException("Unknown command");
            result.put("ok", true);
            answer.putString("result", result.toString());
        } catch (Exception | OutOfMemoryError e) {
            try { answer.putString("result", new JSONObject().put("ok", false).put("error", e.toString()).toString()); }
            catch (Exception ignored) { }
        } finally { Binder.restoreCallingIdentity(identity); }
        return answer;
    }
    private boolean save(WallpaperManager wm, int which, String name) throws IOException {
        try (ParcelFileDescriptor fd = wm.getWallpaperFile(which)) {
            if (fd == null) {
                // No lock file means it shares home. A null home file can be the built-in default.
                if (which == WallpaperManager.FLAG_SYSTEM && wm.getWallpaperId(which) > 1)
                    throw new IOException("Cannot read the previous home wallpaper for rollback");
                if (which == WallpaperManager.FLAG_LOCK && wm.getWallpaperId(which) > 0)
                    throw new IOException("Cannot read the previous lock wallpaper for rollback");
                return false;
            }
            try (InputStream in = new FileInputStream(fd.getFileDescriptor()); OutputStream out = new FileOutputStream(file(name))) { copy(in, out); }
            return true;
        }
    }
    private void restore(WallpaperManager wm, int which, String name, boolean saved) throws IOException {
        if (!saved) { wm.clear(which); return; }
        try (InputStream in = new FileInputStream(file(name))) { wm.setStream(in, null, false, which); }
    }
    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] bytes = new byte[16384]; int n;
        while ((n = in.read(bytes)) != -1) out.write(bytes, 0, n);
    }
    public String getType(Uri uri) { return "application/octet-stream"; }
    public Cursor query(Uri uri, String[] p, String s, String[] a, String o) { throw new UnsupportedOperationException(); }
    public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    public int delete(Uri uri, String s, String[] a) { throw new UnsupportedOperationException(); }
    public int update(Uri uri, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
