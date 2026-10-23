package app.vguard.firewall;
import android.content.Context;import android.content.Intent;import android.net.Uri;import android.provider.DocumentsContract;
public final class ExportTargetTests {
 static int checks;
 static final class Granted extends Context {boolean granted=true;int calls;public int checkUriPermission(Uri uri,int pid,int uid,int flags){calls++;if(flags!=Intent.FLAG_GRANT_WRITE_URI_PERMISSION)throw new AssertionError("incorrect grant checked");return granted?0:-1;}}
 static void reject(Granted context,String value,int flags){checks++;try{ExportTarget.validate(context,value==null?null:Uri.parse(value),flags);throw new AssertionError("accepted "+value);}catch(IllegalArgumentException|SecurityException expected){}}
 public static void main(String[] args){
  Granted context=new Granted();int write=Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
  for(String uri:new String[]{null,"file:///data/user/0/app.vguard.firewall/shared_prefs/rules.xml","http://attacker.test/export","android.resource://app.vguard.firewall/id","content:/document/a","content:///document/a","data:text/csv,forged"})reject(context,uri,write);
  if(context.calls!=0)throw new AssertionError("non-document URI reached permission boundary");
  String good="content://example.documents/document/test%3Afile.csv";
  reject(context,good,0);DocumentsContract.document=false;reject(context,good,write);DocumentsContract.document=true;
  context.granted=false;reject(context,good,write);context.granted=true;DocumentsContract.fail=true;reject(context,good,write);DocumentsContract.fail=false;
  ExportTarget.validate(context,Uri.parse(good),write);checks++;ExportTarget.validate(context,Uri.parse("content://cloud.documents/document/report"),write);checks++;
  context.granted=false;reject(context,good,write);
  System.out.println("PASS export destination boundary: "+checks+" checks; unsafe schemes, missing documents and revoked grants refused.");
 }
}
