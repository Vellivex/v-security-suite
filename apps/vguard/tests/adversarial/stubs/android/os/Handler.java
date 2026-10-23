package android.os;
import testsupport.FakeAndroid;
public final class Handler{public Handler(Looper looper){}public boolean post(Runnable runnable){FakeAndroid.mainQueue.add(runnable);return true;}}
