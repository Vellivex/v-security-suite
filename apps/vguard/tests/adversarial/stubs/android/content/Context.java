package android.content;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import testsupport.FakeAndroid;
public class Context {
 public static final int MODE_PRIVATE=0, RECEIVER_NOT_EXPORTED=4;
 public String getPackageName(){return "app.vguard.firewall";}
 public SharedPreferences getSharedPreferences(String name,int access){FakeAndroid.preferenceModes.add(access); return FakeAndroid.preferences(name);}
 public PackageManager getPackageManager(){return FakeAndroid.packages;}
 public <T> T getSystemService(Class<T> type){return type.cast(FakeAndroid.notifications);}
 public Intent registerReceiver(BroadcastReceiver receiver,IntentFilter filter){return registerReceiver(receiver,filter,0);}
 public Intent registerReceiver(BroadcastReceiver receiver,IntentFilter filter,int flags){FakeAndroid.register(this,receiver,filter,flags);return null;}
 public void unregisterReceiver(BroadcastReceiver receiver){FakeAndroid.unregister(receiver);}
}
