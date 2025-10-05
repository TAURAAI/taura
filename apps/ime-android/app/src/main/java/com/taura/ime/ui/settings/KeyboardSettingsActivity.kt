package com.taura.ime.ui.settings

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import com.taura.ime.data.KeyboardPreferences
import com.taura.ime.ui.theme.TauraImeTheme
import kotlinx.coroutines.launch

class KeyboardSettingsActivity : ComponentActivity() {
    private lateinit var preferences: KeyboardPreferences

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        preferences = KeyboardPreferences(applicationContext)

        setContent {
            TauraImeTheme {
                KeyboardSettingsScreen(
                    initialState = SettingsState(
                        baseUrl = preferences.baseUrl,
                        userId = preferences.userId.orEmpty(),
                        authToken = preferences.authToken.orEmpty()
                    ),
                    onSave = { state ->
                        lifecycleScope.launch {
                            preferences.baseUrl = state.baseUrl
                            preferences.userId = state.userId.ifBlank { null }
                            preferences.authToken = state.authToken.ifBlank { null }
                        }
                    }
                )
            }
        }
    }
}
