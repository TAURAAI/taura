package com.taura.overlay.ime

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioManager
import android.os.Vibrator
import android.util.AttributeSet
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class SimpleKeyboardView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : LinearLayout(context, attrs, defStyleAttr) {
    
    private var imeService: TauraIMEService? = null
    private val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    
    init {
        orientation = VERTICAL
        setBackgroundColor(Color.parseColor("#263238"))
        setPadding(8, 8, 8, 8)
        setupKeyboard()
    }
    
    fun setIMEService(ime: TauraIMEService) {
        this.imeService = ime
    }
    
    private fun setupKeyboard() {
        // Row 1: Numbers
        val numberRow = createKeyRow(listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "0"))
        addView(numberRow)
        
        // Row 2: QWERTY top row
        val topRow = createKeyRow(listOf("q", "w", "e", "r", "t", "y", "u", "i", "o", "p"))
        addView(topRow)
        
        // Row 3: QWERTY middle row
        val middleRow = createKeyRow(listOf("a", "s", "d", "f", "g", "h", "j", "k", "l"))
        addView(middleRow)
        
        // Row 4: QWERTY bottom row with special keys
        val bottomRowLayout = LinearLayout(context).apply {
            orientation = HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { 
                setMargins(0, 4, 0, 4) 
            }
        }
        
        // Shift key (for now just shows "⇧")
        val shiftKey = createKey("⇧", 1.2f) { 
            // Toggle case - simplified
        }
        bottomRowLayout.addView(shiftKey)
        
        // Bottom letter keys
        val bottomLetters = listOf("z", "x", "c", "v", "b", "n", "m")
        for (letter in bottomLetters) {
            val key = createKey(letter, 1f) { commitText(letter) }
            bottomRowLayout.addView(key)
        }
        
        // Backspace key
        val backspaceKey = createKey("⌫", 1.2f) { 
            imeService?.currentInputConnection?.deleteSurroundingText(1, 0)
        }
        bottomRowLayout.addView(backspaceKey)
        
        addView(bottomRowLayout)
        
        // Row 5: Space bar and special keys
        val spaceRowLayout = LinearLayout(context).apply {
            orientation = HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { 
                setMargins(0, 4, 0, 4) 
            }
        }
        
        // Comma
        val commaKey = createKey(",", 1f) { commitText(",") }
        spaceRowLayout.addView(commaKey)
        
        // Space bar
        val spaceKey = createKey("Space", 4f) { commitText(" ") }
        spaceRowLayout.addView(spaceKey)
        
        // Period
        val periodKey = createKey(".", 1f) { commitText(".") }
        spaceRowLayout.addView(periodKey)
        
        // Enter
        val enterKey = createKey("↵", 1.2f) { 
            imeService?.currentInputConnection?.sendKeyEvent(
                KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)
            )
            imeService?.currentInputConnection?.sendKeyEvent(
                KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)
            )
        }
        spaceRowLayout.addView(enterKey)
        
        // AI Assist button
        val aiKey = createKey("🤖", 1f) { 
            commitText("🤖") // Placeholder for AI integration
        }
        spaceRowLayout.addView(aiKey)
        
        addView(spaceRowLayout)
        
        // Add extra space at bottom for gesture navigation
        val spacer = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                48 // 48dp for gesture navigation
            )
        }
        addView(spacer)
    }
    
    private fun createKeyRow(keys: List<String>): LinearLayout {
        val rowLayout = LinearLayout(context).apply {
            orientation = HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { 
                setMargins(0, 4, 0, 4) 
            }
        }
        
        for (key in keys) {
            val keyView = createKey(key, 1f) { commitText(key) }
            rowLayout.addView(keyView)
        }
        
        return rowLayout
    }
    
    private fun createKey(text: String, weight: Float, action: () -> Unit): Button {
        return Button(context).apply {
            this.text = text
            textSize = 16f
            typeface = Typeface.DEFAULT
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#37474F"))
            
            layoutParams = LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                weight
            ).apply {
                setMargins(2, 2, 2, 2)
            }
            
            minHeight = 120 // 48dp equivalent
            gravity = Gravity.CENTER
            isAllCaps = false
            
            setOnClickListener {
                // Vibration feedback
                vibrator?.vibrate(30)
                
                // Audio feedback
                audioManager?.playSoundEffect(AudioManager.FX_KEYPRESS_STANDARD)
                
                // Perform action
                action()
            }
        }
    }
    
    private fun commitText(text: String) {
        imeService?.currentInputConnection?.commitText(text, 1)
    }
}
