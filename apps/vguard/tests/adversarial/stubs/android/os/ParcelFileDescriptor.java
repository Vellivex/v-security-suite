package android.os;
import java.io.FileDescriptor;
import java.io.IOException;
import testsupport.FakeAndroid;
public final class ParcelFileDescriptor {
 public final FakeAndroid.Tun tun;
 public ParcelFileDescriptor(FakeAndroid.Tun tun){this.tun=tun;}
 public FileDescriptor getFileDescriptor(){return tun.fd;}
 public void close()throws IOException{tun.close();}
}
