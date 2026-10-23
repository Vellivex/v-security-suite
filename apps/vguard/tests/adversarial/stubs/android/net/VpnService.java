package android.net;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.ParcelFileDescriptor;
import java.util.LinkedHashSet;
import java.util.Set;
import testsupport.FakeAndroid;
public class VpnService extends Context {
 public static final int START_NOT_STICKY=2,STOP_FOREGROUND_REMOVE=1;
 public boolean stopped,frameworkForeground;public int foregroundType;
 public Notification notification;
 public void onCreate(){}public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}public void onDestroy(){}public void onRevoke(){}
 public void stopSelf(){stopped=true;FakeAndroid.timeline.add("stopSelf");}
 public void stopForeground(int flags){frameworkForeground=false;FakeAndroid.timeline.add("stopForeground");}
 public void startForeground(int id,Notification notification){startForeground(id,notification,0);}
 public void startForeground(int id,Notification notification,int type){
  if(FakeAndroid.failForeground){FakeAndroid.failForeground=false;throw new SecurityException("injected foreground failure");}
  frameworkForeground=true;foregroundType=type;this.notification=notification;FakeAndroid.timeline.add("foreground");
 }
 public static Intent prepare(Context context){return FakeAndroid.consent?null:new Intent();}
 public class Builder {
  public final Set<String> allowed=new LinkedHashSet<String>(),routes=new LinkedHashSet<String>(),addresses=new LinkedHashSet<String>(),dns=new LinkedHashSet<String>();
  public int mtu;public boolean blocking=true;
  public Builder setSession(String value){return this;}public Builder setConfigureIntent(PendingIntent value){return this;}
  public Builder setMtu(int value){mtu=value;return this;}public Builder addAddress(String ip,int prefix){addresses.add(ip+"/"+prefix);return this;}
  public Builder addRoute(String ip,int prefix){routes.add(ip+"/"+prefix);return this;}public Builder addDnsServer(String ip){dns.add(ip);return this;}
  public Builder setBlocking(boolean value){blocking=value;return this;}
  public Builder addAllowedApplication(String name)throws PackageManager.NameNotFoundException{
   if(name.equals(FakeAndroid.packages.disappearOnBuilderAdd)){FakeAndroid.packages.remove(name);}
   FakeAndroid.packages.getApplicationInfo(name,0);allowed.add(name);return this;
  }
  public ParcelFileDescriptor establish(){
   FakeAndroid.establishCalls++;FakeAndroid.lastBuilder=this;
   if(allowed.isEmpty())FakeAndroid.emptyEstablishCalls++;
   String outcome=FakeAndroid.establishOutcomes.poll();
   if("null".equals(outcome))return null;
   if("security".equals(outcome))throw new SecurityException("injected establish denial");
   if("runtime".equals(outcome))throw new IllegalStateException("injected establish failure");
   FakeAndroid.Tun tun=new FakeAndroid.Tun(allowed,routes,dns,mtu,blocking);
   FakeAndroid.tuns.add(tun);FakeAndroid.timeline.add("establish:"+tun.id);return new ParcelFileDescriptor(tun);
  }
 }
}
