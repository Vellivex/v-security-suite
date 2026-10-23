// SPDX-License-Identifier: GPL-3.0-or-later
package app.vguard.firewall;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Process;
import android.provider.DocumentsContract;

/** Only a writable Storage Access Framework document is an export target. */
final class ExportTarget {
    private ExportTarget() {}

    static void validate(Context context, Uri uri, int resultFlags) {
        if (context == null || uri == null || !"content".equals(uri.getScheme())
                || uri.getAuthority() == null || uri.getAuthority().isEmpty()) {
            throw new IllegalArgumentException("Choose a document using Android's file picker.");
        }
        if ((resultFlags & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == 0
                || !DocumentsContract.isDocumentUri(context, uri)
                || context.checkUriPermission(uri, Process.myPid(), Process.myUid(),
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            throw new SecurityException("Android did not grant write access to this document. Please export again.");
        }
    }
}
