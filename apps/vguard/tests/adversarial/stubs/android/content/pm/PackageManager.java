package android.content.pm;
import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
public class PackageManager {
 public final Map<String,Integer> installed=new ConcurrentHashMap<String,Integer>();
 public String disappearOnBuilderAdd;
 public void install(String name,int uid){installed.put(name,Integer.valueOf(uid));}
 public void remove(String name){installed.remove(name);}
 public ApplicationInfo getApplicationInfo(String name,int flags)throws NameNotFoundException{
  Integer uid=installed.get(name);if(uid==null)throw new NameNotFoundException(name);
  ApplicationInfo info=new ApplicationInfo();info.uid=uid.intValue();info.packageName=name;return info;
 }
 public String[] getPackagesForUid(int uid){
  ArrayList<String> names=new ArrayList<String>();for(Map.Entry<String,Integer> item:installed.entrySet())if(item.getValue().intValue()==uid)names.add(item.getKey());
  return names.isEmpty()?null:names.toArray(new String[names.size()]);
 }
 public static class NameNotFoundException extends Exception {public NameNotFoundException(String message){super(message);}}
}
