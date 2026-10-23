package android.net;
public final class Uri {
 private final String value;private Uri(String value){this.value=value;}
 public static Uri parse(String value){return new Uri(value);}
 public String getSchemeSpecificPart(){int colon=value.indexOf(':');return colon<0?value:value.substring(colon+1);}
 public String getScheme(){int colon=value.indexOf(':');return colon<0?null:value.substring(0,colon);}
}
