package com.taura.ime.data

import android.content.Context
import com.taura.ime.model.Suggestion
import java.util.ArrayDeque

class TauraRepository(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = KeyboardPreferences(appContext)

    private var currentBaseUrl: String = preferences.baseUrl
    private var apiClient: TauraApiClient = createClient(currentBaseUrl)
    private val recentSuggestions = ArrayDeque<Suggestion>()

    suspend fun fetchSuggestions(query: String, topK: Int = 6): List<Suggestion> {
        val normalized = query.trim()
        if (normalized.isEmpty()) {
            return recentSuggestions.toList()
        }

        ensureClient()
        val result = apiClient.search(normalized, preferences.userId, topK)
        val remote = result.getOrElse {
            return recentSuggestions.toList()
        }

        return remote.map { api ->
            Suggestion(
                id = api.mediaId ?: api.uri ?: api.title ?: normalized,
                title = api.title ?: api.uri ?: "Suggested item",
                subtitle = api.snippet ?: api.modality,
                uri = api.uri,
                commitText = buildCommitText(api.title, normalized)
            )
        }.also { suggestions ->
            updateRecentSuggestions(suggestions)
        }
    }

    fun preferences(): KeyboardPreferences = preferences

    private fun buildCommitText(title: String?, fallback: String): String =
        title?.takeIf { it.isNotBlank() } ?: fallback

    private fun updateRecentSuggestions(items: List<Suggestion>) {
        if (items.isEmpty()) return
        items.forEach { suggestion ->
            recentSuggestions.removeAll { it.id == suggestion.id }
            recentSuggestions.addFirst(suggestion)
        }
        while (recentSuggestions.size > 10) {
            recentSuggestions.removeLast()
        }
    }

    private fun ensureClient() {
        val preferred = preferences.baseUrl
        if (preferred != currentBaseUrl) {
            currentBaseUrl = preferred
            apiClient = createClient(preferred)
        }
    }

    private fun createClient(baseUrl: String): TauraApiClient =
        TauraApiClient(baseUrl = baseUrl) { preferences.authToken }
}
