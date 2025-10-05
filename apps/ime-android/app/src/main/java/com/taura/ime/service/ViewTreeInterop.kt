package com.taura.ime.service

import android.view.View
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ViewModelStoreOwner
import androidx.savedstate.SavedStateRegistryOwner

/**
 * Minimal reflection-based adaptor for setting and clearing Jetpack ViewTree owners
 * without depending on the lifecycle and saved state artifacts at compile time.
 */
internal object ViewTreeInterop {
    private val lifecycleClass = runCatching {
        Class.forName("androidx.lifecycle.ViewTreeLifecycleOwner")
    }.getOrNull()

    private val viewModelClass = runCatching {
        Class.forName("androidx.lifecycle.ViewTreeViewModelStoreOwner")
    }.getOrNull()

    private val savedStateClass = runCatching {
        Class.forName("androidx.savedstate.ViewTreeSavedStateRegistryOwner")
    }.getOrNull()

    private val lifecycleSet = lifecycleClass?.methods?.firstOrNull { method ->
        method.name == "set" && method.parameterTypes.size == 2
    }

    private val viewModelSet = viewModelClass?.methods?.firstOrNull { method ->
        method.name == "set" && method.parameterTypes.size == 2
    }

    private val savedStateSet = savedStateClass?.methods?.firstOrNull { method ->
        method.name == "set" && method.parameterTypes.size == 2
    }

    fun attach(view: View, owner: LifecycleOwner, storeOwner: ViewModelStoreOwner, registryOwner: SavedStateRegistryOwner) {
        runCatching { lifecycleSet?.invoke(null, view, owner) }
        runCatching { viewModelSet?.invoke(null, view, storeOwner) }
        runCatching { savedStateSet?.invoke(null, view, registryOwner) }
    }

    fun clear(view: View) {
        runCatching { lifecycleSet?.invoke(null, view, null) }
        runCatching { viewModelSet?.invoke(null, view, null) }
        runCatching { savedStateSet?.invoke(null, view, null) }
    }
}
