package app.vguard.firewall;
import java.util.*;
public final class ParserStress {
 public static void main(String[] args){
  long seed=args.length==0?0x564755415244L:Long.decode(args[0]);
  Random random=new Random(seed);long trials=0,parsed=0;long begin=System.nanoTime();
  for(int i=0;i<150000;i++){
   int n=i%1000==0?65575:random.nextInt(513);byte[] p=new byte[n];random.nextBytes(p);
   if(n>0 && i%3!=0)p[0]=(byte)((i%2==0?0x40:0x60)|(p[0]&15));
   int[] lengths={n,Math.max(0,n-1),-1,n+1,Integer.MAX_VALUE};
   for(int length:lengths){trials++;PacketInfo m=PacketInfo.parse(p,length);if(m!=null){parsed++;if(!m.destination.matches("[0-9a-fA-F:.%]+"))throw new AssertionError("non-numeric destination");if(!m.appName.equals("Selected app"))throw new AssertionError("spoofed app field");for(String field:Arrays.asList(m.destination,m.protocol,m.appName)){for(char c:field.toCharArray())if(Character.isISOControl(c))throw new AssertionError("control character in metadata");}if(m.port < -1 || m.port >65535)throw new AssertionError("port bounds");}}
  }
  for(int extensionCount=0;extensionCount<100;extensionCount++){
   byte[] p=new byte[40+8*extensionCount+8];p[0]=0x60;p[4]=(byte)((p.length-40)>>8);p[5]=(byte)(p.length-40);p[6]=0;
   for(int j=0;j<extensionCount;j++){p[40+j*8]=(byte)(j==extensionCount-1?17:0);p[41+j*8]=0;}
   PacketInfo.parse(p,p.length);trials++;
  }
  System.out.println("PASS parser stress seed="+seed+": "+trials+" calls, "+parsed+" metadata results; no exception, control-character metadata, or invalid port; elapsedMs="+(System.nanoTime()-begin)/1000000);
 }
}
