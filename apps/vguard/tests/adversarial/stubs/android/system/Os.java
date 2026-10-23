package android.system;
import java.io.FileDescriptor;
import testsupport.FakeAndroid;
public final class Os {
 public static int poll(StructPollfd[] values,int timeout)throws ErrnoException{
  StructPollfd item=values[0];FakeAndroid.Tun tun=FakeAndroid.lookup(item.fd);
  synchronized(tun){
   if(tun.pollErrno!=0){int errno=tun.pollErrno;tun.pollErrno=0;throw new ErrnoException("poll",errno);}
   if(tun.queue.isEmpty()&&!tun.closed&&tun.pollFlags==0&&tun.readErrno==0&&!tun.zeroRead){
    try{tun.wait(timeout);}catch(InterruptedException e){throw new ErrnoException("poll",OsConstants.EINTR);}
   }
   if(tun.closed){item.revents=(short)OsConstants.POLLNVAL;return 1;}
   if(tun.pollFlags!=0){item.revents=(short)tun.pollFlags;return 1;}
   if(!tun.queue.isEmpty()||tun.readErrno!=0||tun.zeroRead){item.revents=(short)OsConstants.POLLIN;return 1;}
   item.revents=0;return 0;
  }
 }
 public static int read(FileDescriptor descriptor,byte[] buffer,int offset,int length)throws ErrnoException{
  FakeAndroid.Tun tun=FakeAndroid.lookup(descriptor);byte[] packet;
  tun.readerThread=Thread.currentThread();
  synchronized(tun){
   if(tun.closed)throw new ErrnoException("read",OsConstants.EBADF);
   if(tun.readErrno!=0){int errno=tun.readErrno;tun.readErrno=0;throw new ErrnoException("read",errno);}
   if(tun.zeroRead){tun.zeroRead=false;return 0;}
   packet=tun.queue.poll();if(packet==null)throw new ErrnoException("read",OsConstants.EAGAIN);
  }
  if(tun.readEntered!=null){tun.readEntered.countDown();try{tun.releaseRead.await();}catch(InterruptedException ignored){try{tun.releaseRead.await();}catch(InterruptedException e){throw new ErrnoException("read",OsConstants.EINTR);}}}
  int count=Math.min(length,packet.length);System.arraycopy(packet,0,buffer,offset,count);return count;
 }
}
