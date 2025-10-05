package com.taura.ime.service

import android.inputmethodservice.InputMethodService
import android.inputmethodservice.Keyboard
import android.inputmethodservice.KeyboardView
import android.os.SystemClock
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedTextRequest
import android.widget.FrameLayout
import com.taura.ime.R
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
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

class TauraKeyboardService : InputMethodService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var repository: TauraRepository
    private lateinit var suggestionManager: SuggestionManager
    private var composeEnvironment: ComposeEnvironment? = null
    private var keyboardController: SimpleKeyboardController? = null

    override fun onCreate() {
        super.onCreate()
        repository = TauraRepository(applicationContext)
        suggestionManager = SuggestionManager(repository, serviceScope)
    }

    override fun onCreateInputView(): View {
        keyboardController?.release()
        keyboardController = null
        composeEnvironment?.dispose()

        val root = layoutInflater.inflate(R.layout.keyboard_root, null)
        val suggestionContainer = root.findViewById<FrameLayout>(R.id.suggestion_container)
        val composeView = ComposeView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
        }
        suggestionContainer.addView(composeView)

        val environment = ComposeEnvironment(suggestionContainer, composeView)
        composeEnvironment = environment
        environment.bindDecorView(window?.window?.decorView)

        composeView.setContent {
            val suggestions by suggestionManager.suggestions.collectAsState()
            TauraImeTheme {
                SuggestionStrip(
                    suggestions = suggestions,
                    onSuggestionSelected = ::commitSuggestion,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 8.dp, vertical = 6.dp)
                )
            }
        }
        val keyboardView = root.findViewById<KeyboardView>(R.id.keyboard_view)
        keyboardController = SimpleKeyboardController(keyboardView)

        environment.onStart()
        return root
    }

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        suggestionManager.updateQuery("")
        composeEnvironment?.onResume()
        keyboardController?.setShifted(shouldAutoCapitalize(attribute))
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
        keyboardController?.setShifted(shouldAutoCapitalize(currentInputEditorInfo))
    }

    override fun onFinishInput() {
        super.onFinishInput()
        suggestionManager.cancel()
        composeEnvironment?.onPause()
        keyboardController?.setShifted(false)
    }

    override fun onDestroy() {
        super.onDestroy()
        composeEnvironment?.dispose()
        composeEnvironment = null
        keyboardController?.release()
        keyboardController = null
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

    private inner class SimpleKeyboardController(
        private val keyboardView: KeyboardView
    ) : KeyboardView.OnKeyboardActionListener {

        private val keyboard = Keyboard(this@TauraKeyboardService, R.xml.keyboard_qwerty)
        private val keys = keyboard.keys
        private val baseLabels = keys.map { it.label?.toString() }
        private var isShifted = false

        init {
            keyboardView.keyboard = keyboard
            keyboardView.isPreviewEnabled = false
            keyboardView.setOnKeyboardActionListener(this)
            updateLabels()
        }

        fun setShifted(shifted: Boolean) {
            if (isShifted == shifted) return
            isShifted = shifted
            keyboard.isShifted = shifted
            keyboardView.isShifted = shifted
            updateLabels()
        }

        override fun onKey(primaryCode: Int, keyCodes: IntArray?) {
            val ic = currentInputConnection ?: return
            when (primaryCode) {
                Keyboard.KEYCODE_DELETE -> {
                    val selected = ic.getSelectedText(0)
                    if (selected.isNullOrEmpty()) {
                        ic.deleteSurroundingText(1, 0)
                    } else {
                        ic.commitText("", 1)
                    }
                }
                Keyboard.KEYCODE_SHIFT -> setShifted(!isShifted)
                Keyboard.KEYCODE_CANCEL -> requestHideSelf(0)
                Keyboard.KEYCODE_DONE -> performEditorActionOrEnter()
                32 -> ic.commitText(" ", 1)
                44, 39, 46, 63 -> ic.commitText(primaryCode.toChar().toString(), 1)
                else -> {
                    val committed = commitCharacter(primaryCode)
                    if (!committed) {
                        sendDownUpKeyEvents(primaryCode)
                    }
                }
            }
        }

        private fun commitCharacter(code: Int): Boolean {
            if (code !in 97..122) return false
            val base = code.toChar()
            val text = if (isShifted) base.uppercaseChar().toString() else base.toString()
            currentInputConnection?.commitText(text, 1)
            if (isShifted) {
                setShifted(false)
            }
            return true
        }

        private fun sendDownUpKeyEvents(keyEventCode: Int) {
            val downTime = SystemClock.uptimeMillis()
            val eventDown = KeyEvent(downTime, downTime, KeyEvent.ACTION_DOWN, keyEventCode, 0)
            val eventUp = KeyEvent(downTime, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, keyEventCode, 0)
            currentInputConnection?.sendKeyEvent(eventDown)
            currentInputConnection?.sendKeyEvent(eventUp)
        }

        private fun performEditorActionOrEnter() {
            val editorInfo = this@TauraKeyboardService.currentInputEditorInfo
            val actionId = editorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
            val handled = when (actionId) {
                EditorInfo.IME_ACTION_NONE, EditorInfo.IME_ACTION_UNSPECIFIED ->
                    currentInputConnection?.performEditorAction(EditorInfo.IME_ACTION_DONE) ?: false
                else -> currentInputConnection?.performEditorAction(actionId) ?: false
            }
            if (!handled) {
                sendDownUpKeyEvents(KeyEvent.KEYCODE_ENTER)
            }
        }

        private fun updateLabels() {
            keys.forEachIndexed { index, key ->
                val base = baseLabels[index] ?: return@forEachIndexed
                if (key.codes.isNotEmpty()) {
                    when (key.codes[0]) {
                        in 97..122 -> {
                            key.label = if (isShifted) base.uppercase() else base.lowercase()
                        }
                        Keyboard.KEYCODE_SHIFT -> key.on = isShifted
                    }
                }
            }
            keyboardView.invalidateAllKeys()
        }

        override fun onPress(primaryCode: Int) {}
        override fun onRelease(primaryCode: Int) {}
        override fun onText(text: CharSequence?) {
            if (!text.isNullOrEmpty()) {
                currentInputConnection?.commitText(text, 1)
            }
        }
        override fun swipeLeft() {}
        override fun swipeRight() {}
        override fun swipeDown() {}
        override fun swipeUp() {}

        fun release() {
            keyboardView.setOnKeyboardActionListener(null)
            keyboardView.keyboard = null
        }
    }

    private class ComposeEnvironment(
        private val hostView: View,
        val composeView: ComposeView
    ) : LifecycleOwner, ViewModelStoreOwner, SavedStateRegistryOwner {

        private val lifecycleRegistry = LifecycleRegistry(this)
        private val store = ViewModelStore()
        private val savedStateController = SavedStateRegistryController.create(this)
        private var decorView: View? = null

        init {
            ViewTreeInterop.attach(hostView, this, this, this)
            ViewTreeInterop.attach(composeView, this, this, this)
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
            composeView.disposeComposition()
            lifecycleRegistry.currentState = Lifecycle.State.DESTROYED
            ViewTreeInterop.clear(composeView)
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
}
