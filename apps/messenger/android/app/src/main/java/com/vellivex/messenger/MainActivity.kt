package com.vellivex.messenger

import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.core.graphics.createBitmap
import androidx.core.graphics.set
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val Ink = Color(0xFF0C151B)
private val Surface = Color(0xFF14212B)
private val Accent = Color(0xFFA5E5ED)
private val Muted = Color(0xFFAABCC7)

class MessengerApplication : Application() {
    val repository by lazy { MatrixRepository(this) }
}

class MessengerViewModel(application: Application) : AndroidViewModel(application) {
    val repository = (application as MessengerApplication).repository
    var signInEmail by mutableStateOf("")
    var serverAddress by mutableStateOf("")
    init { viewModelScope.launch { repository.restore() } }
    fun run(action: suspend MatrixRepository.() -> Unit) { viewModelScope.launch { repository.action() } }
    fun send(text: String, accepted: () -> Unit) { viewModelScope.launch { if (repository.sendMessage(text)) accepted() } }
}

class MainActivity : ComponentActivity() {
    private val model: MessengerViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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
    var showProfile by remember { mutableStateOf(false) }
    var showNewChat by remember { mutableStateOf(false) }
    var signOut by remember { mutableStateOf(false) }
    val snackbars = remember { SnackbarHostState() }
    LaunchedEffect(state.error) {
        state.error?.let { snackbars.showSnackbar(it); model.run { clearError() } }
    }
    BackHandler(state.selectedRoomId != null) { model.run { closeRoom() } }
    Scaffold(containerColor = Ink, snackbarHost = { SnackbarHost(snackbars) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (state.userId == null) {
                SignIn(state, model, onRequest = { server, email -> model.run { requestCode(server, email) } },
                    onVerify = { model.run { verifyCode(it) } },
                    restore = { model.run { restore() } }, reset = { signOut = true })
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
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
        }
    }
    if (showProfile && state.userId != null) ProfileDialog(state.userId!!,
        close = { showProfile = false }, signOut = { showProfile = false; signOut = true })
    if (showNewChat) NewChatDialog(close = { showNewChat = false }, create = {
        showNewChat = false; model.run { createDirectMessage(it) }
    })
    if (signOut) AlertDialog(onDismissRequest = { signOut = false },
        title = { Text("Sign out of this phone?") },
        text = { Text("This removes the session and encryption keys from this phone. This alpha has no key recovery, so you may lose access to your message history. The other person keeps their copy.") },
        confirmButton = { TextButton(onClick = { signOut = false; model.run { signOut() } }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { signOut = false }) { Text("Keep signed in") } })
    state.verification?.let { v -> VerificationDialog(v, state.busy,
        accept = { model.run { acceptVerification() } },
        confirm = { model.run { confirmVerification() } },
        cancel = { model.run { cancelVerification() } }) }
}

@Composable
private fun SignIn(state: MessengerState, model: MessengerViewModel, onRequest: (String, String) -> Unit, onVerify: (String) -> Unit, restore: () -> Unit, reset: () -> Unit) {
    val server = model.serverAddress
    val email = model.signInEmail
    var code by remember { mutableStateOf("") }
    var serverSettings by remember { mutableStateOf(false) }
    var signInHelp by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp),
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
        Text(if (state.codeRequested) "Enter the one-time code sent to your email." else "Conversations for you and your people. No phone number. No address book upload.",
            color = Muted, fontSize = 16.sp, lineHeight = 24.sp)
        if (!state.codeRequested) {
            OutlinedTextField(email, { model.signInEmail = it.take(254) }, label = { Text("Email address") },
                singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            Button(onClick = { onRequest(server.trim(), email.trim()) },
                enabled = !state.busy && email.contains('@') && server.isNotBlank(), modifier = Modifier.fillMaxWidth().height(54.dp)) {
                Text("Continue with email", fontWeight = FontWeight.SemiBold)
            }
        } else {
            OutlinedTextField(code, { code = it.filter { digit -> digit in '0'..'9' }.take(8) }, label = { Text("Eight-digit email code") },
                singleLine = true, enabled = !state.busy, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
            Button(onClick = { onVerify(code); code = "" }, enabled = !state.busy && code.length == 8,
                modifier = Modifier.fillMaxWidth().height(54.dp)) { Text("Open Vellivex") }
            TextButton(onClick = { onRequest(server.trim(), email.trim()) }, enabled = !state.busy) { Text("Send another code") }
        }
        TextButton(onClick = { serverSettings = !serverSettings }, enabled = !state.busy && !state.codeRequested,
            contentPadding = PaddingValues(0.dp)) {
            Icon(Icons.Outlined.Settings, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Test server settings")
        }
        if (serverSettings) {
            OutlinedTextField(server, { model.serverAddress = it.take(300) }, label = { Text("Server address") },
                placeholder = { Text("https://your-test-server") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                supportingText = { Text("Use the server supplied with your test invitation.") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        }
        TextButton(onClick = { signInHelp = !signInHelp }, enabled = !state.busy, contentPadding = PaddingValues(0.dp)) { Text("Trouble signing in?") }
        if (signInHelp) {
            Text("A saved session keeps your message keys on this phone. Try restoring it before removing it.", color = Muted, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = restore, enabled = !state.busy) { Text("Restore session") }
                TextButton(onClick = reset, enabled = !state.busy) { Text("Reset this device") }
            }
        }
        Spacer(Modifier.weight(1f))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Outlined.Lock, null, Modifier.size(17.dp), tint = Muted)
            Text("Early test build. A configured server is required. Use test conversations while we verify delivery and device security.",
                fontSize = 12.sp, lineHeight = 18.sp, color = Muted)
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
                modifier = Modifier.align(Alignment.BottomEnd).padding(24.dp), icon = { Icon(Icons.Outlined.Edit, null) }, text = { Text("New conversation") })
        }
    }
}

@Composable
private fun Chat(state: MessengerState, back: () -> Unit, send: (String, () -> Unit) -> Unit, retry: (String) -> Unit, verify: () -> Unit, join: () -> Unit) {
    var draft by remember(state.selectedRoomId) { mutableStateOf("") }
    val list = rememberLazyListState()
    val room = state.selectedRoom
    LaunchedEffect(state.messages.size) { if (state.messages.isNotEmpty()) list.animateScrollToItem(state.messages.lastIndex + 1) }
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
        LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(if (room?.encrypted == true) "Messages are end-to-end encrypted. Your server still sees account and conversation metadata."
                    else "This conversation cannot be used for private messages.",
                    color = Muted, fontSize = 12.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp))
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
private fun ProfileDialog(userId: String, close: () -> Unit, signOut: () -> Unit) {
    val context = LocalContext.current
    val invitation = "https://matrix.to/#/$userId"
    val qr = remember(invitation) {
        val bits = QRCodeWriter().encode(invitation, BarcodeFormat.QR_CODE, 360, 360)
        createBitmap(360, 360).also { bitmap ->
            for (y in 0 until 360) for (x in 0 until 360) bitmap[x, y] = if (bits[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
        }.asImageBitmap()
    }
    AlertDialog(onDismissRequest = close, title = { Text("Your Vellivex ID") },
        text = { Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(15.dp)) {
            Image(qr, "QR code for your public contact ID", Modifier.size(200.dp))
            Text(userId, textAlign = TextAlign.Center, fontSize = 13.sp)
            Text("Share this to receive an invitation. It contains your contact ID, never your email or encryption keys.", color = Muted, fontSize = 13.sp)
            OutlinedButton(onClick = {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, invitation) }, "Share your Vellivex ID"))
            }) { Icon(Icons.Outlined.Share, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Share invitation") }
            Text("Vellivex Messenger ${BuildConfig.VERSION_NAME}\nFree core messaging · No paid features in this alpha", color = Muted, fontSize = 11.sp, textAlign = TextAlign.Center)
        } }, confirmButton = { TextButton(onClick = close) { Text("Done") } }, dismissButton = { TextButton(onClick = signOut) { Text("Sign out") } })
}

@Composable
private fun VerificationDialog(v: MessengerVerification, busy: Boolean, accept: () -> Unit, confirm: () -> Unit, cancel: () -> Unit) {
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
        }, dismissButton = { if (v.stage != MessengerVerificationStage.Done) TextButton(onClick = cancel) {
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
