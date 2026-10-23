package android.content;
import java.util.Set;
public interface SharedPreferences {
 Set<String> getStringSet(String key, Set<String> fallback);
 String getString(String key, String fallback);
 Editor edit();
 interface Editor { Editor putStringSet(String key, Set<String> value); Editor putString(String key, String value); void apply(); }
}
