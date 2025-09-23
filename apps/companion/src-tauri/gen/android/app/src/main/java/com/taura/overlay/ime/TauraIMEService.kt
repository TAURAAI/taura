package com.taura.overlay.ime

import android.inputmethodservice.InputMethodService
import android.util.Log
import android.view.View

class TauraIMEService : InputMethodService() {
    private var keyboardView: SimpleKeyboardView? = null
    
    override fun onCreateInputView(): View {
        Log.d("TauraIME", "Creating input view")
        
        keyboardView = SimpleKeyboardView(this).apply {
            setIMEService(this@TauraIMEService)
        }
        
        return keyboardView!!
    }
    
    override fun onStartInput(attribute: android.view.inputmethod.EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        Log.d("TauraIME", "Starting input - restarting: $restarting")
    }
    
    override fun onStartInputView(info: android.view.inputmethod.EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        Log.d("TauraIME", "Starting input view - restarting: $restarting")
    }
    
    override fun onFinishInput() {
        super.onFinishInput()
        Log.d("TauraIME", "Finishing input")
    }
    
    override fun onDestroy() {
        super.onDestroy()
        Log.d("TauraIME", "IME Service destroyed")
    }
}
