package app.vguard.firewall;
import android.content.Intent;
import java.util.HashSet;
import java.util.Arrays;
import testsupport.FakeAndroid;
public final class PackageIdentityRaceTests {
    public static void main(String[] args) throws Exception {
        for (boolean duringEstablish : new boolean[] {false,true}) {
            FakeAndroid.reset();FakeAndroid.packages.install("sample.selected",12001);
            GuardService service=new GuardService();service.onCreate();
            RuleStore.setBlocked(service,"normal",new HashSet<String>(Arrays.asList("sample.selected")));
            if(duringEstablish)FakeAndroid.sharedUidRaceOnEstablish=true;
            else FakeAndroid.sharedUidRaceOnAdd=true;
            service.onStartCommand(new Intent().setAction(GuardService.ACTION_START)
                    .putExtra(GuardService.EXTRA_MODE,"normal"),0,1);
            Thread.sleep(30);FakeAndroid.drainMain();
            if (!"ERROR".equals(GuardService.snapshot().phase))throw new AssertionError("Changed package identity must reject configuration");
            for(FakeAndroid.Tun tun:FakeAndroid.tuns)if(!tun.closed)throw new AssertionError("Rejected identity left an open tunnel");
            if(!duringEstablish && FakeAndroid.establishCalls!=0)throw new AssertionError("Known identity race should be rejected before establishment");
            service.onDestroy();FakeAndroid.drainMain();
        }
        System.out.println("PASS: package identity races before and during establish rejected without a retained tunnel");
    }
}
