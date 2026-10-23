package android.content;
import java.util.HashSet;
import java.util.Set;
public class IntentFilter {
 public final Set<String> actions=new HashSet<String>(),schemes=new HashSet<String>();
 public void addAction(String value){actions.add(value);} public void addDataScheme(String value){schemes.add(value);}
}
