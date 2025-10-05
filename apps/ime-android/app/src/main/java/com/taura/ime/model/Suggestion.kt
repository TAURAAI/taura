package com.taura.ime.model

import android.view.inputmethod.InputConnection

/**
 * Represents a search result that can be inserted into the current editor.
 */
data class Suggestion(
    val id: String,
    val title: String,
    val subtitle: String?,
    val uri: String?,
    val commitText: String
) {
    fun commitInto(connection: InputConnection) {
        connection.commitText(commitText, 1)
    }
}
