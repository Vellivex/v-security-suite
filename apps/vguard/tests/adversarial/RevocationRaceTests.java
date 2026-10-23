package app.vguard.firewall;
import android.content.Intent;
import java.util.HashSet;
import java.util.Arrays;
import testsupport.FakeAndroid;

/** Reproduces revocation re-entering configure while establish is in flight. */
public final class RevocationRaceTests {
    public static void main(String[] args) throws Exception {
        FakeAndroid.reset();
        FakeAndroid.packages.install("sample.selected",12001);
        GuardService service=new GuardService(); service.onCreate();
        RuleStore.setBlocked(service,"normal",new HashSet<String>(Arrays.asList("sample.selected")));
        FakeAndroid.revokeDuringEstablish=true;
        service.onStartCommand(new Intent().setAction(GuardService.ACTION_START)
                .putExtra(GuardService.EXTRA_MODE,"normal"),0,1);
        Thread.sleep(30);
        FakeAndroid.drainMain();
        if ("ACTIVE".equals(GuardService.snapshot().phase) || !FakeAndroid.latest().closed)
            throw new AssertionError("Revocation must invalidate establishment and close its descriptor");
        service.onDestroy(); FakeAndroid.drainMain();
        System.out.println("PASS: revocation during establish cannot publish ACTIVE or retain its descriptor");
    }
}
