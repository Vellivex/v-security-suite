package testsupport;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.VpnService;
import android.system.ErrnoException;
import android.system.OsConstants;
import java.io.FileDescriptor;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;

/** Controlled framework boundary, not a network emulator or Android implementation. */
public final class FakeAndroid {
 public static final PackageManager packages=new PackageManager();
 public static final NotificationManager notifications=new NotificationManager();
 public static final ConcurrentLinkedQueue<Runnable> mainQueue=new ConcurrentLinkedQueue<Runnable>();
 public static final ConcurrentLinkedQueue<String> establishOutcomes=new ConcurrentLinkedQueue<String>();
 public static final List<String> timeline=new CopyOnWriteArrayList<String>();
 public static final List<Tun> tuns=new CopyOnWriteArrayList<Tun>();
 public static final List<Integer> preferenceModes=new CopyOnWriteArrayList<Integer>();
 public static final List<Registration> receivers=new CopyOnWriteArrayList<Registration>();
 public static final Map<String,Prefs> stores=new HashMap<String,Prefs>();
 public static final Map<FileDescriptor,Tun> descriptors=Collections.synchronizedMap(new IdentityHashMap<FileDescriptor,Tun>());
 public static volatile boolean consent=true,failForeground,revokeDuringEstablish,sharedUidRaceOnAdd,sharedUidRaceOnEstablish;
 public static volatile int establishCalls,emptyEstablishCalls;
 public static volatile VpnService.Builder lastBuilder;
 private static int nextTun;
 public static void reset(){
  mainQueue.clear();establishOutcomes.clear();timeline.clear();tuns.clear();preferenceModes.clear();receivers.clear();stores.clear();descriptors.clear();
  packages.installed.clear();packages.disappearOnBuilderAdd=null;packages.install("app.vguard.firewall",11000);
  consent=true;failForeground=false;revokeDuringEstablish=false;sharedUidRaceOnAdd=false;sharedUidRaceOnEstablish=false;establishCalls=0;emptyEstablishCalls=0;lastBuilder=null;
 }
 public static synchronized Prefs preferences(String name){Prefs p=stores.get(name);if(p==null){p=new Prefs();stores.put(name,p);}return p;}
 public static void drainMain(){Runnable next;int count=0;while((next=mainQueue.poll())!=null){next.run();if(++count>1000)throw new AssertionError("Main callback storm");}}
 public static Tun latest(){return tuns.get(tuns.size()-1);}
 public static Tun lookup(FileDescriptor descriptor)throws ErrnoException{Tun value=descriptors.get(descriptor);if(value==null)throw new ErrnoException("lookup",OsConstants.EBADF);return value;}
 public static void register(Context context,BroadcastReceiver receiver,IntentFilter filter,int flags){receivers.add(new Registration(context,receiver,filter,flags));}
 public static void unregister(BroadcastReceiver receiver){for(Registration value:receivers)if(value.receiver==receiver){receivers.remove(value);return;}throw new IllegalArgumentException("not registered");}
 public static void broadcast(String action,String name,int uid,boolean replacing){
  broadcast(new Intent().setAction(action).setData(Uri.parse("package:"+name)).putExtra(Intent.EXTRA_UID,uid).putExtra(Intent.EXTRA_REPLACING,replacing));
 }
 public static void broadcastWithoutUid(String action,String name){
  broadcast(new Intent().setAction(action).setData(Uri.parse("package:"+name)));
 }
 private static void broadcast(Intent intent){
  String action=intent.getAction();
  for(Registration value:new ArrayList<Registration>(receivers))if(value.filter.actions.contains(action)&&value.filter.schemes.contains("package"))value.receiver.onReceive(value.context,intent);
 }
 public static final class Registration{
  public final Context context;public final BroadcastReceiver receiver;public final IntentFilter filter;public final int flags;
  Registration(Context c,BroadcastReceiver r,IntentFilter f,int flags){context=c;receiver=r;filter=f;this.flags=flags;}
 }
 public static final class Tun{
  public final int id=++nextTun;public final FileDescriptor fd=new FileDescriptor();
  public final Set<String> allowed,routes,dns;public final Set<Integer> routedUids=new HashSet<Integer>();
  public final int mtu;public final boolean blocking;
  public final ArrayDeque<byte[]> queue=new ArrayDeque<byte[]>();
  public volatile boolean closed,zeroRead;public volatile int closeCalls,pollFlags,pollErrno,readErrno;
  public volatile CountDownLatch readEntered,releaseRead;
  public volatile Thread readerThread;
  public Tun(Set<String> apps,Set<String> routes,Set<String> dns,int mtu,boolean blocking){
   allowed=Collections.unmodifiableSet(new LinkedHashSet<String>(apps));this.routes=new LinkedHashSet<String>(routes);this.dns=new LinkedHashSet<String>(dns);this.mtu=mtu;this.blocking=blocking;
   for(String name:apps){Integer uid=packages.installed.get(name);if(uid!=null)routedUids.add(uid);}
   descriptors.put(fd,this);
  }
  public synchronized void enqueue(byte[] packet){queue.add(packet.clone());notifyAll();}
  public synchronized void faultRead(int errno){readErrno=errno;notifyAll();}
  public synchronized void faultPoll(int flags){pollFlags=flags;notifyAll();}
  public synchronized void signalZeroRead(){zeroRead=true;notifyAll();}
  public synchronized void close()throws IOException{closeCalls++;closed=true;timeline.add("close:"+id);notifyAll();}
  public boolean routesPackage(String name){Integer uid=packages.installed.get(name);return !closed&&uid!=null&&routedUids.contains(uid);}
 }
 public static final class Prefs implements SharedPreferences{
  public final Map<String,Object> data=new HashMap<String,Object>();
  @SuppressWarnings("unchecked") public synchronized Set<String> getStringSet(String key,Set<String> fallback){Object v=data.get(key);if(v==null)return fallback;if(!(v instanceof Set))throw new ClassCastException();return (Set<String>)v;}
  public synchronized String getString(String key,String fallback){Object v=data.get(key);if(v==null)return fallback;if(!(v instanceof String))throw new ClassCastException();return (String)v;}
  public SharedPreferences.Editor edit(){return new Editor();}
  private class Editor implements SharedPreferences.Editor{
   private final Map<String,Object> changes=new HashMap<String,Object>();
   public SharedPreferences.Editor putStringSet(String key,Set<String> value){changes.put(key,new HashSet<String>(value));return this;}
   public SharedPreferences.Editor putString(String key,String value){changes.put(key,value);return this;}
   public void apply(){synchronized(Prefs.this){data.putAll(changes);}}
  }
 }
}
