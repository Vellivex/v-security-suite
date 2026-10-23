package android.app;
import android.content.Context;
import android.content.Intent;
public class PendingIntent {
 public static final int FLAG_UPDATE_CURRENT=1,FLAG_IMMUTABLE=2;
 public final Intent intent;public final int flags;
 private PendingIntent(Intent intent,int flags){this.intent=intent;this.flags=flags;}
 public static PendingIntent getActivity(Context context,int id,Intent intent,int flags){return new PendingIntent(intent,flags);}
 public static PendingIntent getService(Context context,int id,Intent intent,int flags){return new PendingIntent(intent,flags);}
}
