package com.taura.ime.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.taura.ime.R
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KeyboardSettingsScreen(
    initialState: SettingsState,
    onSave: suspend (SettingsState) -> Unit
) {
    val snackbarHostState = remember { SnackbarHostState() }
    val coroutineScope = rememberCoroutineScope()
    var state by remember { mutableStateOf(initialState) }
    val savedSnackbarMessage = stringResource(id = R.string.settings_saved_snackbar)
    val saveButtonLabel = stringResource(id = R.string.settings_save_button)

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            horizontalAlignment = Alignment.Start
        ) {
            Text(text = stringResource(id = R.string.settings_title), style = MaterialTheme.typography.headlineSmall)
            Text(text = stringResource(id = R.string.settings_description), style = MaterialTheme.typography.bodyMedium)

            SettingsField(
                label = stringResource(id = R.string.settings_base_url_label),
                value = state.baseUrl,
                onValueChange = { state = state.copy(baseUrl = it) }
            )
            SettingsField(
                label = stringResource(id = R.string.settings_user_id_label),
                value = state.userId,
                onValueChange = { state = state.copy(userId = it) }
            )
            SettingsField(
                label = stringResource(id = R.string.settings_token_label),
                value = state.authToken,
                onValueChange = { state = state.copy(authToken = it) },
                obscure = true
            )

            Spacer(modifier = Modifier.height(12.dp))

            Button(onClick = {
                coroutineScope.launch {
                    onSave(state)
                    snackbarHostState.showSnackbar(
                        message = savedSnackbarMessage,
                        duration = SnackbarDuration.Short
                    )
                }
            }) {
                Text(text = saveButtonLabel)
            }

            Text(
                text = stringResource(id = R.string.settings_enable_instructions),
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun SettingsField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    obscure: Boolean = false
) {
    TextField(
        modifier = Modifier.fillMaxWidth(),
        value = value,
        onValueChange = onValueChange,
        label = { Text(text = label) },
        singleLine = true,
        visualTransformation = if (obscure) PasswordVisualTransformation() else VisualTransformation.None,
        colors = TextFieldDefaults.colors()
    )
}

data class SettingsState(
    val baseUrl: String,
    val userId: String,
    val authToken: String
)
