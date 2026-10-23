package android.system;
public class ErrnoException extends Exception{public final int errno;public ErrnoException(String name,int errno){super(name+" errno "+errno);this.errno=errno;}}
