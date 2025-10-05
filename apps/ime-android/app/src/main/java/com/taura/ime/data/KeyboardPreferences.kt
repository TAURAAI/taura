package com.taura.ime.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

private const val PREFS_NAME = "taura_keyboard_prefs"
private const val KEY_BASE_URL = "base_url"
private const val KEY_USER_ID = "user_id"
private const val KEY_AUTH_TOKEN = "auth_token"

class KeyboardPreferences(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, BuildDefaults.defaultBaseUrl) ?: BuildDefaults.defaultBaseUrl
        set(value) = prefs.edit { putString(KEY_BASE_URL, value.trim()) }

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(value) = prefs.edit { putString(KEY_USER_ID, value?.trim()) }

    var authToken: String?
        get() = prefs.getString(KEY_AUTH_TOKEN, null)
        set(value) = prefs.edit { putString(KEY_AUTH_TOKEN, value?.trim()) }

    private object BuildDefaults {
        val defaultBaseUrl: String = com.taura.ime.BuildConfig.DEFAULT_SEARCH_BASE_URL
    }
}
