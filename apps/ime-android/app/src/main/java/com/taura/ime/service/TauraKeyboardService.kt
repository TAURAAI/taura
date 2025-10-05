package com.taura.ime.service

import android.inputmethodservice.InputMethodService
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedTextRequest
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Backspace
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.outlined.KeyboardCapslock
import androidx.compose.material.icons.outlined.KeyboardHide
import androidx.compose.material.ripple.rememberRipple
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.contentColorFor
import androidx.compose.material3.surfaceColorAtElevation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import com.taura.ime.data.TauraRepository
import com.taura.ime.model.Suggestion
import com.taura.ime.ui.components.SuggestionStrip
import com.taura.ime.ui.theme.TauraImeTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.collections.buildList

class TauraKeyboardService : InputMethodService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var repository: TauraRepository
    private lateinit var suggestionManager: SuggestionManager
    private var composeEnvironment: ComposeEnvironment? = null
    private val keyboardController = KeyboardController()

    override fun onCreate() {
        super.onCreate()
        repository = TauraRepository(applicationContext)
        suggestionManager = SuggestionManager(repository, serviceScope)
    }

    override fun onCreateInputView(): View {
        composeEnvironment?.dispose()

        val composeView = ComposeView(this).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        }

        val environment = ComposeEnvironment(composeView)
        composeEnvironment = environment
        environment.bindDecorView(window?.window?.decorView)

        composeView.setContent {
            val suggestions by suggestionManager.suggestions.collectAsState()
            val keyboardState by keyboardController.uiState.collectAsState()
            TauraImeTheme {
                TauraKeyboardScreen(
                    suggestions = suggestions,
                    keyboardState = keyboardState,
                    onSuggestionSelected = ::commitSuggestion,
                    onKeyAction = { action -> keyboardController.onKey(action) }
                )
            }
        }

        environment.onStart()
        return composeView
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        suggestionManager.updateQuery("")
        composeEnvironment?.onResume()
        keyboardController.prepareForInput(shouldAutoCapitalize(attribute))
    }

    override fun onUpdateSelection(
        oldSelStart: Int,
        oldSelEnd: Int,
        newSelStart: Int,
        newSelEnd: Int,
        candidatesStart: Int,
        candidatesEnd: Int
    ) {
        super.onUpdateSelection(
            oldSelStart,
            oldSelEnd,
            newSelStart,
            newSelEnd,
            candidatesStart,
            candidatesEnd
        )
        val query = currentInputConnection
            ?.getExtractedText(ExtractedTextRequest(), 0)
            ?.text
            ?.toString()
            ?: return
        suggestionManager.updateQuery(query)
        keyboardController.setAutoShift(shouldAutoCapitalize(currentInputEditorInfo))
    }

    override fun onFinishInput() {
        super.onFinishInput()
        suggestionManager.cancel()
        composeEnvironment?.onPause()
        keyboardController.reset()
    }

    override fun onDestroy() {
        super.onDestroy()
        composeEnvironment?.dispose()
        composeEnvironment = null
        keyboardController.reset()
        serviceScope.cancel()
    }

    override fun onEvaluateFullscreenMode(): Boolean = false

    private fun commitSuggestion(suggestion: Suggestion) {
        currentInputConnection?.let { connection ->
            suggestion.commitInto(connection)
        }
    }

    private fun shouldAutoCapitalize(attribute: EditorInfo?): Boolean {
        val inputType = attribute?.inputType ?: return false
        val connection = currentInputConnection ?: return false
        return connection.getCursorCapsMode(inputType) != 0
    }

    private inner class KeyboardController {
        private val _uiState = MutableStateFlow(KeyboardUiState())
        val uiState: StateFlow<KeyboardUiState> = _uiState.asStateFlow()

        private var lastShiftTap = 0L

        fun prepareForInput(autoShift: Boolean) {
            lastShiftTap = 0L
            _uiState.value = KeyboardUiState(isShifted = autoShift)
        }

        fun reset() {
            lastShiftTap = 0L
            _uiState.value = KeyboardUiState()
        }

        fun setAutoShift(shouldShift: Boolean) {
            _uiState.update { state ->
                if (state.layout != KeyboardLayout.Letters || state.isCapsLock) state
                else state.copy(isShifted = shouldShift)
            }
        }

        fun onKey(action: KeyAction) {
            when (action) {
                is KeyAction.Character -> commitCharacter(action.char)
                is KeyAction.Text -> commitText(action.value)
                KeyAction.Space -> commitText(" ")
                KeyAction.Delete -> handleDelete()
                KeyAction.Enter -> performEditorActionOrEnter()
                KeyAction.Hide -> requestHideSelf(0)
                KeyAction.Shift -> handleShiftTapped()
                KeyAction.SwitchToSymbols -> switchLayout(KeyboardLayout.Symbols)
                KeyAction.SwitchToLetters -> switchLayout(KeyboardLayout.Letters)
            }
        }

        private fun commitCharacter(char: Char) {
            val state = _uiState.value
            val value = if (state.shouldUppercase) char.uppercaseChar().toString() else char.toString()
            currentInputConnection?.commitText(value, 1)
            if (state.layout == KeyboardLayout.Letters && !state.isCapsLock) {
                setShiftState(isShifted = false, isCapsLock = false)
            }
        }

        private fun commitText(text: String) {
            currentInputConnection?.commitText(text, 1)
            text.lastOrNull()?.let { handlePostCommit(it) }
        }

        private fun handleDelete() {
            val connection = currentInputConnection ?: return
            val selected = connection.getSelectedText(0)
            if (!selected.isNullOrEmpty()) {
                connection.commitText("", 1)
            } else {
                connection.deleteSurroundingText(1, 0)
            }
            if (_uiState.value.layout == KeyboardLayout.Letters && !_uiState.value.isCapsLock) {
                setShiftState(isShifted = shouldAutoCapitalize(currentInputEditorInfo), isCapsLock = false)
            }
        }

        private fun handleShiftTapped() {
            val state = _uiState.value
            if (state.layout != KeyboardLayout.Letters) {
                switchLayout(KeyboardLayout.Letters)
                return
            }

            val now = SystemClock.uptimeMillis()
            when {
                state.isCapsLock -> setShiftState(isShifted = false, isCapsLock = false)
                !state.isShifted -> {
                    lastShiftTap = now
                    setShiftState(isShifted = true, isCapsLock = false)
                }
                now - lastShiftTap <= DOUBLE_TAP_THRESHOLD_MS -> {
                    setShiftState(isShifted = true, isCapsLock = true)
                }
                else -> {
                    setShiftState(isShifted = false, isCapsLock = false)
                }
            }
            lastShiftTap = now
        }

        private fun handlePostCommit(lastChar: Char) {
            if (_uiState.value.layout != KeyboardLayout.Letters) return
            when (lastChar) {
                '.', '!', '?' -> setShiftState(isShifted = true)
                else -> if (!_uiState.value.isCapsLock) setShiftState(isShifted = false)
            }
        }

        private fun performEditorActionOrEnter() {
            val info = currentInputEditorInfo
            val actionId = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
            val handled = when (actionId) {
                EditorInfo.IME_ACTION_NONE, EditorInfo.IME_ACTION_UNSPECIFIED ->
                    currentInputConnection?.performEditorAction(EditorInfo.IME_ACTION_DONE) ?: false
                else -> currentInputConnection?.performEditorAction(actionId) ?: false
            }
            if (!handled) {
                sendKeyEvent(KeyEvent.KEYCODE_ENTER)
            }
        }

        private fun switchLayout(layout: KeyboardLayout) {
            if (_uiState.value.layout == layout) return
            lastShiftTap = 0L
            _uiState.value = KeyboardUiState(layout = layout)
            if (layout == KeyboardLayout.Letters) {
                setAutoShift(shouldAutoCapitalize(currentInputEditorInfo))
            }
        }

        private fun sendKeyEvent(keyCode: Int) {
            val downTime = SystemClock.uptimeMillis()
            val eventDown = KeyEvent(downTime, downTime, KeyEvent.ACTION_DOWN, keyCode, 0)
            val eventUp = KeyEvent(downTime, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyCode, 0)
            currentInputConnection?.sendKeyEvent(eventDown)
            currentInputConnection?.sendKeyEvent(eventUp)
        }

        private fun setShiftState(isShifted: Boolean, isCapsLock: Boolean = _uiState.value.isCapsLock) {
            _uiState.update { it.copy(isShifted = isShifted, isCapsLock = isCapsLock) }
        }
    }

    private class ComposeEnvironment(private val hostView: View) : LifecycleOwner,
        ViewModelStoreOwner, SavedStateRegistryOwner {

        private val lifecycleRegistry = LifecycleRegistry(this)
        private val store = ViewModelStore()
        private val savedStateController = SavedStateRegistryController.create(this)
        private var decorView: View? = null

        init {
            ViewTreeInterop.attach(hostView, this, this, this)
            savedStateController.performAttach()
            savedStateController.performRestore(null)
            lifecycleRegistry.currentState = Lifecycle.State.CREATED
        }

        fun bindDecorView(view: View?) {
            decorView = view
            view?.let { ViewTreeInterop.attach(it, this, this, this) }
        }

        fun onStart() {
            lifecycleRegistry.currentState = Lifecycle.State.STARTED
        }

        fun onResume() {
            lifecycleRegistry.currentState = Lifecycle.State.RESUMED
        }

        fun onPause() {
            lifecycleRegistry.currentState = Lifecycle.State.STARTED
        }

        fun dispose() {
            lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
            ViewTreeInterop.clear(hostView)
            decorView?.let(ViewTreeInterop::clear)
            decorView = null
            store.clear()
        }

        override val lifecycle: Lifecycle
            get() = lifecycleRegistry

        override val viewModelStore: ViewModelStore
            get() = store

        override val savedStateRegistry: SavedStateRegistry
            get() = savedStateController.savedStateRegistry
    }

    private companion object {
        private const val DOUBLE_TAP_THRESHOLD_MS = 350L
    }
}

private enum class KeyboardLayout { Letters, Symbols }

private data class KeyboardUiState(
    val layout: KeyboardLayout = KeyboardLayout.Letters,
    val isShifted: Boolean = false,
    val isCapsLock: Boolean = false
) {
    val shouldUppercase: Boolean get() = isShifted || isCapsLock
}

private sealed interface KeyAction {
    data class Character(val char: Char) : KeyAction
    data class Text(val value: String) : KeyAction
    object Space : KeyAction
    object Shift : KeyAction
    object Delete : KeyAction
    object Enter : KeyAction
    object Hide : KeyAction
    object SwitchToSymbols : KeyAction
    object SwitchToLetters : KeyAction
}

private data class KeyDescriptor(
    val action: KeyAction,
    val weight: Float = 1f,
    val label: String? = null,
    val icon: ImageVector? = null,
    val emphasized: Boolean = false,
    val height: Dp = 48.dp
)

private data class RowSpec(
    val keys: List<KeyDescriptor>,
    val leadingWeight: Float = 0f,
    val trailingWeight: Float = 0f
)

@Composable
private fun TauraKeyboardScreen(
    suggestions: List<Suggestion>,
    keyboardState: KeyboardUiState,
    onSuggestionSelected: (Suggestion) -> Unit,
    onKeyAction: (KeyAction) -> Unit
) {
    val containerColor = MaterialTheme.colorScheme.surfaceColorAtElevation(4.dp)
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom)),
        color = containerColor,
        contentColor = contentColorFor(containerColor),
        tonalElevation = 6.dp,
        shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 16.dp)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            SuggestionStrip(
                suggestions = suggestions,
                onSuggestionSelected = onSuggestionSelected,
                modifier = Modifier.fillMaxWidth()
            )
            KeyboardGrid(
                keyboardState = keyboardState,
                onKeyAction = onKeyAction
            )
        }
    }
}

@Composable
private fun KeyboardGrid(
    keyboardState: KeyboardUiState,
    onKeyAction: (KeyAction) -> Unit
) {
    val rows = when (keyboardState.layout) {
        KeyboardLayout.Letters -> letterRows()
        KeyboardLayout.Symbols -> symbolRows()
    }
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        rows.forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (row.leadingWeight > 0f) {
                    Spacer(modifier = Modifier.weight(row.leadingWeight))
                }
                row.keys.forEach { descriptor ->
                    KeyButton(descriptor, keyboardState, onKeyAction)
                }
                if (row.trailingWeight > 0f) {
                    Spacer(modifier = Modifier.weight(row.trailingWeight))
                }
            }
        }
    }
}

@Composable
private fun RowScope.KeyButton(
    descriptor: KeyDescriptor,
    keyboardState: KeyboardUiState,
    onKeyAction: (KeyAction) -> Unit
) {
    val haptics = LocalHapticFeedback.current
    val interactionSource = remember { MutableInteractionSource() }

    val isShiftActive = descriptor.action == KeyAction.Shift && keyboardState.shouldUppercase

    val (background, content) = when {
        descriptor.emphasized -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
        isShiftActive -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
        descriptor.action == KeyAction.Space -> MaterialTheme.colorScheme.surface to MaterialTheme.colorScheme.onSurface
        else -> MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.9f) to MaterialTheme.colorScheme.onSurface
    }

    Surface(
        modifier = Modifier
            .weight(descriptor.weight)
            .height(descriptor.height)
            .clip(RoundedCornerShape(18.dp)),
        color = background,
        contentColor = content,
        tonalElevation = if (descriptor.emphasized || isShiftActive) 8.dp else 2.dp
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clickable(
                    interactionSource = interactionSource,
                    indication = rememberRipple(bounded = true, color = content)
                ) {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onKeyAction(descriptor.action)
                },
            contentAlignment = Alignment.Center
        ) {
            descriptor.icon?.let { icon ->
                Icon(
                    imageVector = icon,
                    contentDescription = descriptor.label,
                    tint = content
                )
            } ?: run {
                val label = descriptor.resolveLabel(keyboardState)
                if (label.isNotEmpty()) {
                    val style = when (descriptor.action) {
                        is KeyAction.Character -> MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold)
                        KeyAction.Space -> MaterialTheme.typography.labelLarge
                        else -> MaterialTheme.typography.titleMedium
                    }
                    Text(
                        text = label,
                        style = style,
                        color = content,
                        textAlign = TextAlign.Center,
                        maxLines = 1
                    )
                }
            }
        }
    }
}

private fun KeyDescriptor.resolveLabel(state: KeyboardUiState): String {
    return when (val action = action) {
        is KeyAction.Character -> {
            val value = if (state.shouldUppercase) action.char.uppercaseChar() else action.char
            value.toString()
        }
        is KeyAction.Text -> label ?: action.value
        KeyAction.Space -> label ?: "space"
        KeyAction.SwitchToSymbols -> label ?: "?123"
        KeyAction.SwitchToLetters -> label ?: "ABC"
        else -> label ?: ""
    }
}

private fun letterRows(): List<RowSpec> = listOf(
    RowSpec(keys = "qwertyuiop".map { it.toDescriptor() }),
    RowSpec(
        keys = "asdfghjkl".map { it.toDescriptor() },
        leadingWeight = 0.6f,
        trailingWeight = 0.6f
    ),
    RowSpec(
        keys = buildList {
            add(KeyDescriptor(KeyAction.Shift, weight = 1.7f, icon = Icons.Outlined.KeyboardCapslock))
            addAll("zxcvbnm".map { it.toDescriptor() })
            add(KeyDescriptor(KeyAction.Delete, weight = 1.7f, icon = Icons.AutoMirrored.Outlined.Backspace))
        },
        leadingWeight = 0.4f,
        trailingWeight = 0.4f
    ),
    RowSpec(
        keys = listOf(
            KeyDescriptor(KeyAction.SwitchToSymbols, label = "?123", weight = 1.5f),
            KeyDescriptor(KeyAction.Hide, icon = Icons.Outlined.KeyboardHide, weight = 1.2f),
            KeyDescriptor(KeyAction.Text(","), label = ","),
            KeyDescriptor(KeyAction.Space, label = "space", weight = 3.6f, height = 52.dp),
            KeyDescriptor(KeyAction.Text("."), label = "."),
            KeyDescriptor(KeyAction.Enter, icon = Icons.AutoMirrored.Outlined.KeyboardReturn, weight = 1.6f, emphasized = true)
        ),
        leadingWeight = 0.2f,
        trailingWeight = 0.2f
    )
)

private fun symbolRows(): List<RowSpec> = listOf(
    RowSpec(keys = "1234567890".map { KeyDescriptor(KeyAction.Text(it.toString()), label = it.toString()) }),
    RowSpec(
        keys = listOf(
            KeyDescriptor(KeyAction.Text("-"), label = "-"),
            KeyDescriptor(KeyAction.Text("/"), label = "/"),
            KeyDescriptor(KeyAction.Text(":"), label = ":"),
            KeyDescriptor(KeyAction.Text(";"), label = ";"),
            KeyDescriptor(KeyAction.Text("("), label = "("),
            KeyDescriptor(KeyAction.Text(")"), label = ")"),
            KeyDescriptor(KeyAction.Text("\$"), label = "$"),
            KeyDescriptor(KeyAction.Text("&"), label = "&"),
            KeyDescriptor(KeyAction.Text("@"), label = "@"),
            KeyDescriptor(KeyAction.Text("\""), label = "\"")
        ),
        leadingWeight = 0.4f,
        trailingWeight = 0.4f
    ),
    RowSpec(
        keys = buildList {
            add(KeyDescriptor(KeyAction.SwitchToLetters, label = "ABC", weight = 1.5f))
            add(KeyDescriptor(KeyAction.Text("."), label = "."))
            add(KeyDescriptor(KeyAction.Text(","), label = ","))
            add(KeyDescriptor(KeyAction.Text("?"), label = "?"))
            add(KeyDescriptor(KeyAction.Text("!"), label = "!"))
            add(KeyDescriptor(KeyAction.Delete, weight = 1.6f, icon = Icons.AutoMirrored.Outlined.Backspace))
        },
        leadingWeight = 0.4f,
        trailingWeight = 0.4f
    ),
    RowSpec(
        keys = listOf(
            KeyDescriptor(KeyAction.SwitchToLetters, label = "ABC", weight = 1.5f),
            KeyDescriptor(KeyAction.Hide, icon = Icons.Outlined.KeyboardHide, weight = 1.2f),
            KeyDescriptor(KeyAction.Space, label = "space", weight = 3.6f, height = 52.dp),
            KeyDescriptor(KeyAction.Text("'"), label = "'"),
            KeyDescriptor(KeyAction.Enter, icon = Icons.AutoMirrored.Outlined.KeyboardReturn, weight = 1.6f, emphasized = true)
        ),
        leadingWeight = 0.2f,
        trailingWeight = 0.2f
    )
)

private fun Char.toDescriptor(): KeyDescriptor = KeyDescriptor(KeyAction.Character(this))
