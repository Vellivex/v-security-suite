package android.provider;
import android.content.Context;import android.net.Uri;
public final class DocumentsContract {
 public static boolean document=true,fail=false;
 public static boolean isDocumentUri(Context context,Uri uri){if(fail)throw new SecurityException("synthetic provider failure");return document;}
}
