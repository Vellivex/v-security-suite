package android.content;
import android.net.Uri;
import java.util.HashMap;
import java.util.Map;
public class Intent {
 public static final String ACTION_PACKAGE_REMOVED="android.intent.action.PACKAGE_REMOVED",ACTION_PACKAGE_ADDED="android.intent.action.PACKAGE_ADDED",ACTION_PACKAGE_REPLACED="android.intent.action.PACKAGE_REPLACED";
 public static final String EXTRA_REPLACING="android.intent.extra.REPLACING",EXTRA_UID="android.intent.extra.UID";
 public static final int FLAG_ACTIVITY_SINGLE_TOP=1,FLAG_ACTIVITY_CLEAR_TOP=2;
 public static final int FLAG_GRANT_WRITE_URI_PERMISSION=2;
 private String action; private Uri data; private final Map<String,Object> extras=new HashMap<String,Object>();
 public Intent(){} public Intent(Context context,Class<?> type){}
 public Intent setAction(String value){action=value;return this;} public String getAction(){return action;}
 public Intent setData(Uri value){data=value;return this;} public Uri getData(){return data;}
 public Intent setClassName(Context context,String name){return this;} public Intent addFlags(int flags){return this;}
 public Intent putExtra(String name,String value){extras.put(name,value);return this;}
 public Intent putExtra(String name,boolean value){extras.put(name,Boolean.valueOf(value));return this;}
 public Intent putExtra(String name,int value){extras.put(name,Integer.valueOf(value));return this;}
 public String getStringExtra(String name){Object value=extras.get(name);return value instanceof String?(String)value:null;}
 public boolean getBooleanExtra(String name,boolean fallback){Object value=extras.get(name);return value instanceof Boolean?((Boolean)value).booleanValue():fallback;}
 public int getIntExtra(String name,int fallback){Object value=extras.get(name);return value instanceof Integer?((Integer)value).intValue():fallback;}
}
