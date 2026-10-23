package android.app;
import android.content.Context;
public class Notification {
 public static final String CATEGORY_SERVICE="service";public static final int VISIBILITY_PRIVATE=0;
 public String title,text; public PendingIntent stopAction;public boolean ongoing;
 public static class Builder {
  private final Notification value=new Notification(); public Builder(Context context,String channel){}
  public Builder setSmallIcon(int icon){return this;}
  public Builder setContentTitle(String title){value.title=title;return this;}
  public Builder setContentText(String text){value.text=text;return this;}
  public Builder setContentIntent(PendingIntent intent){return this;}
  public Builder setOngoing(boolean ongoing){value.ongoing=ongoing;return this;}
  public Builder setOnlyAlertOnce(boolean value){return this;}
  public Builder setCategory(String value){return this;}
  public Builder setVisibility(int value){return this;}
  public Builder addAction(int icon,String text,PendingIntent intent){value.stopAction=intent;return this;}
  public Notification build(){return value;}
 }
}
