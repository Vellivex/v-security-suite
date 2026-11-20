package com.vellivex.messenger

import android.app.Application
import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.annotation.MainThread
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.IntSize
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.core.graphics.createBitmap
import androidx.core.graphics.set
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

private val Ink = Color(0xFF0C151B)
private val Surface = Color(0xFF14212B)
private val Accent = Color(0xFFA5E5ED)
private val Muted = Color(0xFFAABCC7)
private const val RECOVERED_HISTORY_NOTE = "Your recovery key restores your account’s encryption keys. In this alpha, it may not restore any earlier messages."

class MessengerApplication : Application() {
    val repository by lazy { MatrixRepository(this) }

    override fun onCreate() {
        super.onCreate()
        initializeMessengerPlatform(this)
    }
}

internal enum class SignInInputError(val message: String) {
    Email("Enter a valid email address."),
    Server("Enter the HTTPS address of the Vellivex messaging service."),
    Code("Enter the eight-digit email code."),
}

class MessengerViewModel(application: Application) : AndroidViewModel(application) {
    val repository = (application as MessengerApplication).repository
    var signInEmail by mutableStateOf("")
    var serverAddress by mutableStateOf(BuildConfig.PRODUCTION_SERVER_URL)
    internal var signInInputError by mutableStateOf<SignInInputError?>(null)
        private set
    var authenticationPending by mutableStateOf(false)
        private set
    var recoveryKeyToSave by mutableStateOf<String?>(null)
        private set

    init { restoreSignInSession() }

    @MainThread
    fun requestSignInCode(): Boolean {
        if (!repository.state.value.canStartSignIn || repository.state.value.codeRequested) return false
        val email = signInEmail.trim()
        val server = serverAddress.trim()
        val error = when {
            !isValidMessengerEmail(email) -> SignInInputError.Email
            server.isBlank() -> SignInInputError.Server
            else -> null
        }
        return submitAuthentication(error) { requestCode(server, email) }
    }

    @MainThread
    fun resendSignInCode(onSent: () -> Unit): Boolean {
        if (!repository.state.value.codeRequested) return false
        return submitAuthentication(null) {
            if (resendCode() != null) onSent()
        }
    }

    @MainThread
    fun changeSignInEmail(onChanged: () -> Unit): Boolean {
        if (!repository.state.value.canStartSignIn) return false
        val address = repository.state.value.pendingSignInEmail ?: return false
        return submitAuthentication(null) {
            if (discardSignInChallenge()) {
                signInEmail = address
                onChanged()
            }
        }
    }

    @MainThread
    fun verifySignInCode(code: String): Boolean {
        if (!repository.state.value.codeRequested) return false
        val error = if (code.length != 8 || code.any { it !in '0'..'9' }) SignInInputError.Code else null
        return submitAuthentication(error) { verifyCode(code) }
    }

    @MainThread
    fun restoreSignInSession() {
        submitAuthentication(null) { restore() }
    }

    internal fun clearSignInInputError(error: SignInInputError) {
        if (signInInputError == error) signInInputError = null
    }

    @MainThread
    fun createRecoveryKey() = submitRecovery {
        prepareRecoveryKey()?.let { recoveryKeyToSave = it }
    }

    @MainThread
    fun saveRecoveryKey(lastFour: String) = submitRecovery {
        if (confirmRecoveryKeySaved(lastFour)) recoveryKeyToSave = null
    }

    @MainThread
    fun restoreRecoveryKey(key: String, onRestored: () -> Unit) = submitRecovery {
        if (recoverWithKey(key)) {
            recoveryKeyToSave = null
            onRestored()
        }
    }

    @MainThread
    fun recheckRecovery() = submitRecovery { checkRecovery() }

    fun forgetRecoveryKeyDisplay() {
        recoveryKeyToSave = null
    }

    private fun submitRecovery(action: suspend MatrixRepository.() -> Unit): Boolean {
        val state = repository.state.value
        if (authenticationPending || state.busy || state.userId == null || state.recovery == MessengerRecovery.Ready) return false
        return launchAccountAction(action)
    }

    private fun submitAuthentication(error: SignInInputError?, action: suspend MatrixRepository.() -> Unit): Boolean {
        val state = repository.state.value
        if (authenticationPending || state.busy || state.userId != null) return false
        signInInputError = error
        if (error != null) return false
        return launchAccountAction(action)
    }

    private fun launchAccountAction(action: suspend MatrixRepository.() -> Unit): Boolean {
        authenticationPending = true
        viewModelScope.launch {
            try {
                repository.action()
            } finally {
                authenticationPending = false
            }
        }
        return true
    }

    fun run(action: suspend MatrixRepository.() -> Unit) { viewModelScope.launch { repository.action() } }
    fun send(text: String, accepted: () -> Unit) { viewModelScope.launch { if (repository.sendMessage(text)) accepted() } }
}

class MainActivity : ComponentActivity() {
    private val model: MessengerViewModel by viewModels()
    override fun onStart() {
        super.onStart()
        MessengerBackgroundSyncService.setAppVisible(true)
    }
    override fun onStop() {
        MessengerBackgroundSyncService.setAppVisible(false)
        super.onStop()
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(
                primary = Accent, onPrimary = Ink, background = Ink, surface = Surface,
                onBackground = Color(0xFFF0F6F9), onSurface = Color(0xFFF0F6F9),
                surfaceVariant = Color(0xFF20323F), outline = Color(0xFF435866),
            )) { MessengerApp(model) }
        }
    }
}

@Composable
private fun MessengerApp(model: MessengerViewModel) {
    val state by model.repository.state.collectAsStateWithLifecycle()
    val alertsRunning by MessengerBackgroundSyncService.running.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var showProfile by remember { mutableStateOf(false) }
    var showNewChat by remember { mutableStateOf(false) }
    var signOut by remember { mutableStateOf(false) }
    val canUseMessages = state.recovery == MessengerRecovery.Ready
    val snackbars = remember { SnackbarHostState() }
    val startAlerts = {
        if (!MessengerBackgroundSyncService.start(context)) scope.launch {
            snackbars.showSnackbar("Alerts could not start. Allow Vellivex notifications in Android settings, then try again.")
        }
        Unit
    }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) startAlerts() else scope.launch {
            snackbars.showSnackbar("Notifications are off. Open Vellivex to check your messages.")
        }
    }
    LaunchedEffect(state.userId, state.recovery) {
        if (!canUseMessages) MessengerBackgroundSyncService.stop(context)
        if (state.recovery != MessengerRecovery.SetupRequired) model.forgetRecoveryKeyDisplay()
    }
    LaunchedEffect(state.error) {
        state.error?.let { snackbars.showSnackbar(it); model.run { clearError() } }
    }
    BackHandler(canUseMessages && state.selectedRoomId != null) { model.run { closeRoom() } }
    Scaffold(containerColor = Ink, snackbarHost = { SnackbarHost(snackbars) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            if (state.userId == null) {
                SignIn(state, model, reset = { signOut = true })
            } else if (!canUseMessages) {
                RecoveryGate(state, model, profile = { showProfile = true }, signOut = { signOut = true })
            } else if (state.selectedRoomId != null) {
                Chat(state, back = { model.run { closeRoom() } },
                    send = { text, accepted -> model.send(text, accepted) },
                    retry = { model.run { retryMessage(it) } },
                    verify = { model.run { beginVerification() } },
                    join = { state.selectedRoomId?.let { id -> model.run { joinRoom(id) } } })
            } else {
                Inbox(state, profile = { showProfile = true }, newChat = { showNewChat = true },
                    open = { model.run { openRoom(it) } }, refresh = { model.run { refreshRooms() } })
            }
            if (state.busy || model.authenticationPending) {
                LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
        }
    }
    if (showProfile && state.userId != null && (canUseMessages || state.recovery == MessengerRecovery.SetupRequired)) ProfileDialog(state.userId!!,
        recoveryReady = canUseMessages,
        setupRecovery = { showProfile = false; model.createRecoveryKey() },
        alertsRunning = alertsRunning,
        toggleAlerts = {
            if (alertsRunning) MessengerBackgroundSyncService.stop(context)
            else if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context,
                    Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else startAlerts()
        },
        close = { showProfile = false }, signOut = { showProfile = false; signOut = true })
    if (showNewChat && canUseMessages) NewChatDialog(close = { showNewChat = false }, create = {
        showNewChat = false; model.run { createDirectMessage(it) }
    })
    if (signOut) AlertDialog(onDismissRequest = { signOut = false },
        title = { Text("Sign out of this phone?") },
        text = { Text(if (canUseMessages || state.recovery == MessengerRecovery.OtherDevice)
            "Signing out removes the session and keys from this phone. Keep your saved recovery key. $RECOVERED_HISTORY_NOTE To update Messenger, stay signed in and install the update over this app to keep these keys."
            else "Signing out removes the session and encryption keys from this phone. Set up recovery first if you still have access to your keys here, and keep the saved key. $RECOVERED_HISTORY_NOTE") },
        confirmButton = { TextButton(onClick = { signOut = false; model.run { signOut() } }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { signOut = false }) { Text("Keep signed in") } })
    state.verification?.takeIf { canUseMessages }?.let { v -> VerificationDialog(v, state.busy,
        accept = { model.run { acceptVerification() } },
        confirm = { model.run { confirmVerification() } },
        reject = { model.run { rejectVerification() } },
        cancel = { model.run { cancelVerification() } }) }
}

@Composable
private fun RecoveryGate(state: MessengerState, model: MessengerViewModel, profile: () -> Unit, signOut: () -> Unit) {
    val context = LocalContext.current
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val busy = state.busy || model.authenticationPending
    val key = model.recoveryKeyToSave
    var enteredKey by remember(state.recovery, state.userId) { mutableStateOf("") }
    var lastFour by remember(key) { mutableStateOf("") }
    var copied by remember(key) { mutableStateOf(false) }
    val hideKeyboard = { focus.clearFocus(); keyboard?.hide() }
    val confirm: () -> Unit = {
        if (model.saveRecoveryKey(lastFour)) hideKeyboard()
    }
    val recover: () -> Unit = {
        if (model.restoreRecoveryKey(enteredKey) { enteredKey = "" }) hideKeyboard()
    }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Icon(Icons.Outlined.Lock, null, Modifier.size(44.dp), tint = Accent)
        when (state.recovery) {
            MessengerRecovery.SetupRequired -> {
                Text("Secure your account", style = MaterialTheme.typography.headlineLarge)
                Text("Save a recovery key before signing out or moving phones. $RECOVERED_HISTORY_NOTE", color = Muted)
                if (key == null) {
                    Button(onClick = { model.createRecoveryKey() }, enabled = !busy) { Text("Create recovery key") }
                } else {
                    Text("Save this key in a password manager or write it down somewhere private. Keep it with you when you sign out.", color = Muted)
                    Text(key, modifier = Modifier.fillMaxWidth().testTag("recovery-key")
                        .background(Surface, RoundedCornerShape(8.dp)).padding(14.dp),
                        fontFamily = FontFamily.Monospace, lineHeight = 25.sp)
                    OutlinedButton(onClick = { copied = copyRecoveryKey(context, key) }, enabled = !busy) {
                        Text(if (copied) "Recovery key copied" else "Copy recovery key")
                    }
                    OutlinedTextField(lastFour, { lastFour = it.take(4) }, label = { Text("Last 4 characters") },
                        supportingText = { Text("Enter the last four characters from your saved copy.") },
                        singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (lastFour.length == 4) confirm() }))
                    Button(onClick = confirm, enabled = !busy && lastFour.length == 4) { Text("I've saved my recovery key") }
                }
                TextButton(onClick = profile, enabled = !busy) { Text("Your profile") }
            }
            MessengerRecovery.KeyRequired -> {
                Text("Recover your account", style = MaterialTheme.typography.headlineLarge)
                Text("Enter the recovery key you saved. $RECOVERED_HISTORY_NOTE", color = Muted)
                OutlinedTextField(enteredKey, { enteredKey = it.take(192) }, label = { Text("Recovery key") },
                    singleLine = true, enabled = !busy, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (enteredKey.isNotBlank()) recover() }))
                Button(onClick = recover, enabled = !busy && enteredKey.isNotBlank()) { Text("Recover account") }
            }
            MessengerRecovery.NoRecovery -> {
                Text("Recovery isn’t set up", style = MaterialTheme.typography.headlineLarge)
                Text("If you have a phone where you’re already signed in, set up recovery there first and save the key. Then sign out on that phone and return here. Email sign-in alone can’t restore your account’s encryption keys. $RECOVERED_HISTORY_NOTE", color = Muted)
                OutlinedButton(onClick = { model.recheckRecovery() }, enabled = !busy) { Text("Check again") }
            }
            MessengerRecovery.OtherDevice -> {
                Text("Sign out on your other phone", style = MaterialTheme.typography.headlineLarge)
                Text("Messenger supports one active phone for an account. Save your recovery key and sign out in Messenger on your other phone before continuing here. If you can’t access that phone, this device stays locked. $RECOVERED_HISTORY_NOTE", color = Muted)
                OutlinedButton(onClick = { model.recheckRecovery() }, enabled = !busy) { Text("Check again") }
            }
            MessengerRecovery.Checking -> {
                Text("Checking your keys", style = MaterialTheme.typography.headlineLarge)
                Text("Connect to the internet so Messenger can check whether recovery is set up.", color = Muted)
                OutlinedButton(onClick = { model.recheckRecovery() }, enabled = !busy) { Text("Check again") }
            }
            MessengerRecovery.Ready -> Unit
        }
        TextButton(onClick = signOut, enabled = !busy) { Text("Sign out") }
    }
}

private fun copyRecoveryKey(context: Context, key: String): Boolean {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
    val clipId = UUID.randomUUID().toString()
    val marker = "com.vellivex.messenger.recovery_clip"
    val clip = ClipData.newPlainText("Messenger recovery key", key)
    clip.description.extras = PersistableBundle().apply {
        putBoolean("android.content.extra.IS_SENSITIVE", true)
        putString(marker, clipId)
    }
    try {
        clipboard.setPrimaryClip(clip)
    } catch (_: SecurityException) {
        return false
    }
    Handler(Looper.getMainLooper()).postDelayed({
        try {
            if (clipboard.primaryClipDescription?.extras?.getString(marker) == clipId) {
                if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip()
                else clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
            }
        } catch (_: SecurityException) {
            // Android can disallow clipboard access once this app is in the background.
        }
    }, 90_000L)
    return true
}

@Composable
private fun SignIn(state: MessengerState, model: MessengerViewModel, reset: () -> Unit) {
    if (state.needsSessionRestore) {
        SavedSessionScreen(state, state.busy || model.authenticationPending,
            restore = { model.restoreSignInSession() }, reset = reset)
        return
    }
    val server = model.serverAddress
    val email = model.signInEmail
    val pendingEmail = state.pendingSignInEmail
    val busy = state.busy || model.authenticationPending
    val inputError = model.signInInputError
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var code by remember { mutableStateOf("") }
    var serverSettings by remember { mutableStateOf(false) }
    var signInHelp by remember { mutableStateOf(false) }
    val dismissKeyboard = {
        focus.clearFocus()
        keyboard?.hide()
    }
    val submitEmail: () -> Unit = {
        if (model.requestSignInCode()) {
            dismissKeyboard()
        } else if (model.signInInputError == SignInInputError.Server) {
            serverSettings = true
            dismissKeyboard()
        }
    }
    val submitCode: () -> Unit = {
        if (model.verifySignInCode(code)) {
            code = ""
            dismissKeyboard()
        }
    }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Image(painterResource(R.drawable.ic_vellivex), "Vellivex", Modifier.size(34.dp))
            Text("vellivex", fontWeight = FontWeight.Bold, fontSize = 23.sp)
            Spacer(Modifier.weight(1f))
            Badge(containerColor = Surface, contentColor = Accent) { Text("ALPHA", Modifier.padding(5.dp), letterSpacing = 2.sp) }
        }
        Spacer(Modifier.height(32.dp))
        Box(Modifier.size(68.dp).clip(RoundedCornerShape(22.dp)).background(Surface), Alignment.Center) {
            Icon(Icons.Outlined.Email, null, Modifier.size(32.dp), tint = Accent)
        }
        Text(if (state.codeRequested) "Check your\ninbox." else "A little more\nprivate.",
            fontSize = 43.sp, lineHeight = 47.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-1.5).sp)
        Text(if (pendingEmail != null) "Enter the one-time code sent to $pendingEmail." else "Conversations for you and your people. No phone number. No address book upload.",
            color = Muted, fontSize = 16.sp, lineHeight = 24.sp)
        if (!state.codeRequested) {
            OutlinedTextField(email, {
                model.signInEmail = it.take(254)
                model.clearSignInInputError(SignInInputError.Email)
            }, label = { Text("Email address") }, singleLine = true, enabled = !busy,
                modifier = Modifier.fillMaxWidth(), isError = inputError == SignInInputError.Email,
                supportingText = if (inputError == SignInInputError.Email) ({ Text(inputError.message) }) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submitEmail() }))
            Button(onClick = submitEmail, enabled = !busy, modifier = Modifier.fillMaxWidth().height(54.dp)) {
                Text("Continue with email", fontWeight = FontWeight.SemiBold)
            }
            if (inputError == SignInInputError.Server) Text(inputError.message,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }, color = MaterialTheme.colorScheme.error)
        } else {
            OutlinedTextField(code, {
                code = it.filter { digit -> digit in '0'..'9' }.take(8)
                model.clearSignInInputError(SignInInputError.Code)
            }, label = { Text("Eight-digit email code") }, singleLine = true, enabled = !busy,
                modifier = Modifier.fillMaxWidth(), isError = inputError == SignInInputError.Code,
                supportingText = if (inputError == SignInInputError.Code) ({ Text(inputError.message) }) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submitCode() }))
            Button(onClick = submitCode, enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(54.dp)) { Text("Open Vellivex") }
            TextButton(onClick = {
                if (model.resendSignInCode(onSent = { code = "" })) dismissKeyboard()
            }, enabled = !busy) { Text("Send another code") }
            TextButton(onClick = {
                if (model.changeSignInEmail(onChanged = { code = "" })) dismissKeyboard()
            }, enabled = !busy) { Text("Change email") }
        }
        if (BuildConfig.DEBUG) TextButton(onClick = { serverSettings = !serverSettings }, enabled = !busy && !state.codeRequested,
            contentPadding = PaddingValues(0.dp)) {
            Icon(Icons.Outlined.Settings, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Test server settings")
        }
        if (BuildConfig.DEBUG && serverSettings && !state.codeRequested) {
            OutlinedTextField(server, {
                model.serverAddress = it.take(300)
                model.clearSignInInputError(SignInInputError.Server)
            }, label = { Text("Server address") }, enabled = !busy, isError = inputError == SignInInputError.Server,
                placeholder = { Text("https://your-test-server") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                supportingText = { Text("Use the server supplied with your test invitation.") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done))
        }
        TextButton(onClick = { signInHelp = !signInHelp }, enabled = !busy, contentPadding = PaddingValues(0.dp)) { Text("Trouble signing in?") }
        if (signInHelp) {
            Text("A saved session keeps your message keys on this phone. Try restoring it before removing it.", color = Muted, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { model.restoreSignInSession() }, enabled = !busy) { Text("Restore session") }
                TextButton(onClick = reset, enabled = !busy) { Text("Reset this device") }
            }
        }
        Text("Version ${BuildConfig.VERSION_NAME}", color = Muted, fontSize = 13.sp)
        Spacer(Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.Lock, null, Modifier.size(17.dp), tint = Muted)
            Text(if (BuildConfig.DEBUG) "Early test build. Use test conversations while we verify delivery and device security."
                else "Private test build. Use test conversations while we verify delivery and device security.",
                fontSize = 12.sp, lineHeight = 18.sp, color = Muted)
        }
    }
}

@Composable
internal fun SavedSessionScreen(state: MessengerState, busy: Boolean, restore: () -> Unit, reset: () -> Unit) {
    var showHelp by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(28.dp, 24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Image(painterResource(R.drawable.ic_vellivex), "Vellivex", Modifier.size(34.dp))
            Text("vellivex", fontWeight = FontWeight.Bold, fontSize = 23.sp)
        }
        Text("Version ${BuildConfig.VERSION_NAME}", color = Muted, fontSize = 13.sp)
        Text("Resume your session.", fontSize = 36.sp, lineHeight = 42.sp, fontWeight = FontWeight.SemiBold)
        Text("A saved session is still on this phone. Restore it to continue using this installation.",
            color = Muted, fontSize = 16.sp, lineHeight = 24.sp)
        (state.savedSessionError ?: state.error)?.let { message ->
            Text(message, color = MaterialTheme.colorScheme.error, fontSize = 16.sp,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
        Button(onClick = restore, enabled = !busy, modifier = Modifier.fillMaxWidth().height(54.dp)) {
            Text("Restore session", fontWeight = FontWeight.SemiBold)
        }
        if (busy) Text("Restoring your saved session…", color = Muted, fontSize = 14.sp)
        Text("Keep the app installed and its data on this phone while restoring. An app update does not need a new email sign-in.",
            color = Muted, fontSize = 14.sp, lineHeight = 21.sp)
        TextButton(onClick = { showHelp = !showHelp }, enabled = !busy, contentPadding = PaddingValues(0.dp)) {
            Text("Trouble restoring?")
        }
        if (showHelp) {
            Text("Check your connection and try Restore session again. Sign out only if you intend to remove this phone’s saved session. Recovery may not restore earlier messages.",
                color = Muted, fontSize = 14.sp, lineHeight = 21.sp)
            TextButton(onClick = reset, enabled = !busy) { Text("Sign out of this phone") }
        }
    }
}

@Composable
private fun Inbox(state: MessengerState, profile: () -> Unit, newChat: () -> Unit, open: (String) -> Unit, refresh: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(24.dp, 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Messages", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.SemiBold)
                Text(connectionText(state.connection), color = Muted, style = MaterialTheme.typography.labelMedium)
            }
            IconButton(onClick = refresh) { Icon(Icons.Outlined.Refresh, "Refresh messages") }
            IconButton(onClick = profile) { Icon(Icons.Outlined.AccountCircle, "Your profile") }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .3f))
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (state.rooms.isEmpty()) Column(Modifier.align(Alignment.Center).padding(34.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(15.dp)) {
                Icon(Icons.Outlined.Email, null, Modifier.size(48.dp), tint = Accent)
                Text("Your people. Your space.", fontSize = 23.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
                Text("Start a conversation with someone's Vellivex ID, or share yours to get an invitation.", color = Muted,
                    textAlign = TextAlign.Center, lineHeight = 23.sp)
                OutlinedButton(onClick = profile) { Text("Share my ID") }
            } else LazyColumn(contentPadding = PaddingValues(bottom = 90.dp)) {
                items(state.rooms, key = { it.id }) { room ->
                    Row(Modifier.fillMaxWidth().clickable { open(room.id) }.padding(22.dp, 18.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Avatar(room.title)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(room.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold, fontSize = 17.sp)
                            Text(when {
                                room.membership == MessengerMembership.Invited -> "Conversation invitation"
                                !room.encrypted -> "Messaging blocked · room is not encrypted"
                                room.peerVerified -> "Verified conversation"
                                else -> "Verify your contact to start chatting"
                            }, color = Muted, fontSize = 13.sp, maxLines = 2)
                        }
                        Icon(if (room.peerVerified) Icons.Outlined.CheckCircle else Icons.Outlined.Lock,
                            if (room.peerVerified) "Contact verified" else "Contact not verified", tint = Accent, modifier = Modifier.size(19.dp))
                    }
                }
            }
            ExtendedFloatingActionButton(onClick = newChat, containerColor = Accent, contentColor = Ink,
                modifier = Modifier.align(Alignment.BottomEnd).padding(24.dp), icon = { Icon(Icons.Outlined.Edit, "New conversation") }, text = { Text("New conversation") })
        }
    }
}

@Composable
internal fun Chat(state: MessengerState, back: () -> Unit, send: (String, () -> Unit) -> Unit, retry: (String) -> Unit, verify: () -> Unit, join: () -> Unit) {
    var draft by remember(state.selectedRoomId) { mutableStateOf("") }
    val list = rememberLazyListState()
    var viewportSize by remember { mutableStateOf(IntSize.Zero) }
    val room = state.selectedRoom
    val latestMessage = state.messages.lastOrNull()
    // Follow new replies even at the visible-message limit and after the keyboard resizes the list.
    LaunchedEffect(state.selectedRoomId, state.messages.size, latestMessage, viewportSize) {
        if (latestMessage != null && viewportSize.height > 0) list.animateScrollToItem(state.messages.size)
    }
    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(8.dp, 9.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back to messages") }
            Avatar(room?.title.orEmpty(), small = true)
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(room?.title ?: "Conversation", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(if (room?.peerVerified == true) "Contact verified" else "Contact not verified", color = Muted, fontSize = 12.sp)
            }
            if (room?.encrypted == true && room.membership == MessengerMembership.Joined)
                IconButton(onClick = verify) { Icon(Icons.Outlined.CheckCircle, "Verify contact", tint = Accent) }
        }
        LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxWidth().testTag("conversation_messages")
            .onSizeChanged { viewportSize = it }, contentPadding = PaddingValues(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                // Keep the complete recovery warning reachable without taking space from replies when typing.
                Column(Modifier.fillMaxWidth()) {
                    if (state.recoveredWithKey && room?.encrypted == true && room.membership == MessengerMembership.Joined) {
                        Text(RECOVERED_HISTORY_NOTE, color = Muted, fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
                    }
                    Text(if (room?.encrypted == true) "Messages are end-to-end encrypted. Your server still sees account and conversation metadata."
                        else "This conversation cannot be used for private messages.",
                        color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp))
                }
            }
            items(state.messages, key = { it.id }) { msg ->
                Column(Modifier.fillMaxWidth(), horizontalAlignment = if (msg.own) Alignment.End else Alignment.Start) {
                    Surface(color = if (msg.own) Color(0xFF254B55) else Surface, shape = RoundedCornerShape(19.dp), modifier = Modifier.widthIn(max = 310.dp)) {
                        Column(Modifier.padding(14.dp, 11.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(msg.text, fontSize = 16.sp, lineHeight = 23.sp)
                            Text(messageCaption(msg), fontSize = 10.sp, color = Muted, modifier = Modifier.align(Alignment.End))
                            if (msg.own && msg.delivery == MessengerDelivery.Failed) {
                                TextButton(onClick = { retry(msg.id) }, enabled = !state.busy,
                                    modifier = Modifier.align(Alignment.End), contentPadding = PaddingValues(0.dp)) { Text("Retry") }
                            }
                        }
                    }
                }
            }
        }
        if (room?.membership == MessengerMembership.Invited) {
            Button(onClick = join, enabled = !state.busy, modifier = Modifier.fillMaxWidth().padding(20.dp)) { Text("Accept invitation") }
        } else if (!state.canSend) {
            Column(Modifier.fillMaxWidth().background(Surface).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (room?.encrypted == true) "Compare a short code with your contact before your first message." else "Sending is blocked in this conversation.", fontSize = 14.sp, color = Muted)
                if (room?.encrypted == true && room.peerId != null) Button(onClick = verify, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("Verify contact") }
            }
        } else {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(draft, { if (it.encodeToByteArray().size <= 4096) draft = it }, placeholder = { Text("Write a message") },
                    modifier = Modifier.weight(1f), shape = RoundedCornerShape(25.dp), maxLines = 5)
                FilledIconButton(onClick = { val text = draft; send(text) { if (draft == text) draft = "" } }, enabled = draft.isNotBlank() && !state.busy,
                    modifier = Modifier.size(54.dp)) { Icon(Icons.AutoMirrored.Outlined.Send, "Send message") }
            }
        }
    }
}

@Composable
private fun Avatar(title: String, small: Boolean = false) {
    Box(Modifier.size(if (small) 40.dp else 51.dp).clip(CircleShape).background(Color(0xFF28434E)), Alignment.Center) {
        Text(title.trimStart('@').take(1).uppercase(Locale.ROOT).ifEmpty { "V" }, fontSize = if (small) 18.sp else 22.sp, color = Accent)
    }
}

@Composable
private fun NewChatDialog(close: () -> Unit, create: (String) -> Unit) {
    var contact by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = close, title = { Text("Start a conversation") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Ask your contact for their ID or paste their invitation link.", color = Muted)
            OutlinedTextField(contact, { contact = it.take(512) }, label = { Text("Contact ID or link") }, singleLine = true)
        } }, confirmButton = { TextButton(onClick = { create(contact.trim()) }, enabled = contact.isNotBlank()) { Text("Continue") } },
        dismissButton = { TextButton(onClick = close) { Text("Cancel") } })
}

@Composable
private fun ProfileDialog(userId: String, recoveryReady: Boolean, setupRecovery: () -> Unit,
    alertsRunning: Boolean, toggleAlerts: () -> Unit, close: () -> Unit, signOut: () -> Unit) {
    val context = LocalContext.current
    val invitation = "https://matrix.to/#/$userId"
    val qr = remember(invitation) {
        val bits = QRCodeWriter().encode(invitation, BarcodeFormat.QR_CODE, 360, 360)
        createBitmap(360, 360).also { bitmap ->
            for (y in 0 until 360) for (x in 0 until 360) bitmap[x, y] = if (bits[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }.asImageBitmap()
    }
    AlertDialog(onDismissRequest = close, title = { Text("Your Vellivex ID") },
        text = { Column(Modifier.heightIn(max = 510.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(15.dp)) {
            Image(qr, "QR code for your public contact ID", Modifier.size(200.dp))
            Text(userId, textAlign = TextAlign.Center, fontSize = 13.sp)
            Text("Share this to receive an invitation. It contains your contact ID, never your email or encryption keys.", color = Muted, fontSize = 13.sp)
            OutlinedButton(onClick = {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, invitation) }, "Share your Vellivex ID"))
            }) { Icon(Icons.Outlined.Share, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Share invitation") }
            HorizontalDivider()
            if (recoveryReady) {
                Text("Recovery is set up", fontWeight = FontWeight.SemiBold)
                Text("Keep your saved key somewhere private. $RECOVERED_HISTORY_NOTE",
                    color = Muted, fontSize = 12.sp)
                Text(if (alertsRunning) "Background alerts are on" else "Background alerts are off", fontWeight = FontWeight.SemiBold)
                Text("Keep a visible sync notification to receive generic alerts while the app is closed. Messages and contact names stay out of notifications. Android may pause delivery; reopen Vellivex after a restart or force stop.",
                    color = Muted, fontSize = 12.sp)
                OutlinedButton(onClick = toggleAlerts) { Text(if (alertsRunning) "Stop background alerts" else "Enable background alerts") }
            } else {
                OutlinedButton(onClick = setupRecovery) { Text("Set up recovery") }
            }
            Text("Vellivex Messenger ${BuildConfig.VERSION_NAME}\nFree core messaging · No paid features in this alpha", color = Muted, fontSize = 11.sp, textAlign = TextAlign.Center)
        } }, confirmButton = { TextButton(onClick = close) { Text("Done") } }, dismissButton = { TextButton(onClick = signOut) { Text("Sign out") } })
}

@Composable
private fun VerificationDialog(v: MessengerVerification, busy: Boolean, accept: () -> Unit, confirm: () -> Unit, reject: () -> Unit, cancel: () -> Unit) {
    AlertDialog(onDismissRequest = cancel, title = { Text("Verify your contact") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(v.userId, color = Muted, fontSize = 12.sp)
            when (v.stage) {
                MessengerVerificationStage.Incoming -> Text("Your contact wants to verify this conversation. Compare the code in person or over a call you trust.")
                MessengerVerificationStage.Waiting -> Text("Waiting for your contact to open verification…")
                MessengerVerificationStage.Compare -> {
                    Text("Do these symbols or numbers match exactly on both phones?")
                    if (v.symbols.isNotEmpty()) Text(v.symbols.joinToString("  "), fontSize = 28.sp, textAlign = TextAlign.Center, lineHeight = 42.sp)
                    if (v.numbers.isNotEmpty()) Text(v.numbers.joinToString("  "), fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text("Only confirm after you have compared them with the other person.", color = Muted, fontSize = 13.sp)
                }
                MessengerVerificationStage.Done -> Text("Contact verified. You can now send private messages.")
                MessengerVerificationStage.Failed -> Text("Verification did not complete. Try again with your contact.")
            }
        } },
        confirmButton = {
            when (v.stage) {
                MessengerVerificationStage.Incoming -> TextButton(onClick = accept, enabled = !busy) { Text("Compare codes") }
                MessengerVerificationStage.Compare -> TextButton(onClick = confirm, enabled = !busy) { Text("They match") }
                MessengerVerificationStage.Done, MessengerVerificationStage.Failed -> TextButton(onClick = cancel) { Text("Done") }
                else -> Unit
            }
        }, dismissButton = { if (v.stage != MessengerVerificationStage.Done) TextButton(
            onClick = if (v.stage == MessengerVerificationStage.Compare) reject else cancel,
            enabled = !busy,
        ) {
            Text(if (v.stage == MessengerVerificationStage.Compare) "They don't match" else "Cancel")
        } })
}

private fun connectionText(connection: MessengerConnection): String = when (connection) {
    MessengerConnection.SignedOut -> "Signed out"
    MessengerConnection.Connecting -> "Connecting…"
    MessengerConnection.Syncing -> "Catching up…"
    MessengerConnection.Synced -> "Connected"
    MessengerConnection.Offline -> "Offline · waiting for a connection"
}

private fun messageCaption(message: MessengerMessage): String {
    val time = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(message.timestampMillis))
    return if (!message.own) time else "$time · " + when (message.delivery) {
        MessengerDelivery.Queued -> "Queued"
        MessengerDelivery.Sent -> "Sent to server"
        MessengerDelivery.Failed -> "Not sent"
        MessengerDelivery.Received -> "Received"
    }
}
