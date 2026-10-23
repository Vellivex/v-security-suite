package app.vguard.firewall;
import android.content.Intent;import testsupport.FakeAndroid;import java.util.*;
public final class LifecycleStress {
 static GuardService s;
 static void action(String a,String mode){s.onStartCommand(new Intent().setAction(a).putExtra(GuardService.EXTRA_MODE,mode),0,1);}
 public static void main(String[]args)throws Exception{
  FakeAndroid.reset();FakeAndroid.packages.install("stress.selected.a",12001);FakeAndroid.packages.install("stress.selected.b",12002);
  s=new GuardService();s.onCreate();RuleStore.setBlocked(s,"normal",new HashSet<>(Arrays.asList("stress.selected.a")));RuleStore.setBlocked(s,"journey",new HashSet<>(Arrays.asList("stress.selected.b")));
  for(int i=0;i<300;i++){
   action(GuardService.ACTION_START,i%2==0?"normal":"journey");
   final Thread revoke=new Thread(()->s.onRevoke());revoke.start();
   if(i%3==0)action(GuardService.ACTION_APPLY,"journey");
   else if(i%3==1)action(GuardService.ACTION_STOP,"normal");
   revoke.join();FakeAndroid.drainMain();
   action(GuardService.ACTION_STOP,"normal");FakeAndroid.drainMain();
   for(FakeAndroid.Tun t:FakeAndroid.tuns)if(!t.closed||t.closeCalls!=1)throw new AssertionError("closed descriptor invariant at iteration "+i+": closed="+t.closed+" closeCalls="+t.closeCalls);
   if("ACTIVE".equals(GuardService.snapshot().phase)||GuardService.snapshot().blockedCount!=0)throw new AssertionError("stale ACTIVE after stop");
  }
  s.onDestroy();FakeAndroid.drainMain();int live=0;for(Thread t:Thread.getAllStackTraces().keySet())if(t.getName().equals("VGuard-packet-sink")){t.join(1500);if(t.isAlive())live++;}
  if(live>0)throw new AssertionError("lingering readers="+live);
  System.out.println("PASS 300 concurrent revoke/reconfigure/stop cycles; "+FakeAndroid.tuns.size()+" descriptors closed exactly once; no stale ACTIVE or lingering readers.");
 }
}
