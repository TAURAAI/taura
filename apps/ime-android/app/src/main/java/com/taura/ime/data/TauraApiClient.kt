package com.taura.ime.data

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.io.IOException

class TauraApiClient(
    baseUrl: String,
    private val tokenProvider: () -> String?
) {
    private val moshi: Moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .addInterceptor(HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BASIC
        })
        .build()

    private val requestAdapter = moshi.adapter(SearchRequest::class.java)
    private val responseAdapter = moshi.adapter(SearchResponse::class.java)

    private val endpoint = baseUrl.trimEnd('/') + "/search"
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun search(query: String, userId: String?, topK: Int): Result<List<ApiSuggestion>> =
        withContext(Dispatchers.IO) {
            if (query.isBlank()) {
                return@withContext Result.success(emptyList())
            }

            val payload = SearchRequest(
                userId = userId,
                text = query,
                topK = topK
            )

            val requestBody = requestAdapter.toJson(payload).toRequestBody(jsonMediaType)

            val requestBuilder = Request.Builder()
                .url(endpoint)
                .post(requestBody)
                .header("Content-Type", "application/json")

            tokenProvider()?.takeIf { it.isNotBlank() }?.let { token ->
                requestBuilder.header("Authorization", "Bearer $token")
            }

            return@withContext try {
                client.newCall(requestBuilder.build()).execute().use { response ->
                    if (!response.isSuccessful) {
                        Result.failure(IOException("Unexpected response ${'$'}{response.code}"))
                    } else {
                        val body = response.body?.string().orEmpty()
                        val parsed = responseAdapter.fromJson(body)
                            ?: return@use Result.failure(IllegalStateException("Empty body"))
                        Result.success(parsed.results ?: emptyList())
                    }
                }
            } catch (ioe: IOException) {
                Result.failure(ioe)
            }
        }

    @JsonClass(generateAdapter = true)
    data class SearchRequest(
        @Json(name = "user_id") val userId: String?,
        @Json(name = "text") val text: String,
        @Json(name = "top_k") val topK: Int,
        @Json(name = "filters") val filters: Map<String, Any?>? = null
    )

    @JsonClass(generateAdapter = true)
    data class SearchResponse(
        @Json(name = "results") val results: List<ApiSuggestion>?
    )

    @JsonClass(generateAdapter = true)
    data class ApiSuggestion(
        @Json(name = "media_id") val mediaId: String?,
        @Json(name = "score") val score: Double?,
        @Json(name = "thumb_url") val thumbUrl: String?,
        @Json(name = "uri") val uri: String?,
        @Json(name = "ts") val timestamp: String?,
        @Json(name = "modality") val modality: String?,
        @Json(name = "title") val title: String? = null,
        @Json(name = "snippet") val snippet: String? = null
    )
}
