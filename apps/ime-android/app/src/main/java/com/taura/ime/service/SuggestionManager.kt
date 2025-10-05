package com.taura.ime.service

import com.taura.ime.data.TauraRepository
import com.taura.ime.model.Suggestion
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.launch

private const val QUERY_DEBOUNCE_MS = 150L
private const val MIN_QUERY_LENGTH = 2

class SuggestionManager(
    private val repository: TauraRepository,
    private val scope: CoroutineScope
) {
    private val queryFlow = MutableSharedFlow<String>(
        replay = 1,
        extraBufferCapacity = 16,
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )

    private val _suggestions = MutableStateFlow<List<Suggestion>>(emptyList())
    val suggestions: StateFlow<List<Suggestion>> = _suggestions.asStateFlow()

    private var loader: Job? = null

    init {
        loader = scope.launch { collectQueries() }
    }

    fun updateQuery(newValue: String) {
        queryFlow.tryEmit(newValue)
    }

    fun cancel() {
        loader?.cancel()
        _suggestions.value = emptyList()
    }

    @OptIn(FlowPreview::class)
    private suspend fun collectQueries() {
        queryFlow
            .debounce(QUERY_DEBOUNCE_MS)
            .mapLatest { query ->
                val trimmed = query.trim()
                if (trimmed.length < MIN_QUERY_LENGTH) {
                    repository.fetchSuggestions("")
                } else {
                    repository.fetchSuggestions(trimmed)
                }
            }
            .distinctUntilChanged()
            .collect { items ->
                _suggestions.value = items
            }
    }
}
