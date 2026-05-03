package com.flowlink.app.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.service.BackendConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class AuthActivity : AppCompatActivity() {

    private lateinit var tabLogin: TextView
    private lateinit var tabSignup: TextView
    private lateinit var etUsername: EditText
    private lateinit var etPassword: EditText
    private lateinit var etConfirmPassword: EditText
    private lateinit var tvConfirmLabel: TextView
    private lateinit var btnSubmit: Button
    private lateinit var tvError: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var tvSwitch: TextView

    private var isLoginMode = true

    companion object {
        private const val PREFS = "flowlink"
        private const val KEY_TOKEN = "auth_token"
        private const val KEY_USERNAME = "username"
        private const val KEY_ROLE = "user_role"

        fun isLoggedIn(ctx: Context): Boolean {
            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return prefs.getString(KEY_TOKEN, null) != null &&
                   prefs.getString(KEY_USERNAME, null)?.isNotEmpty() == true
        }

        fun getToken(ctx: Context): String? =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)

        fun getUsername(ctx: Context): String =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_USERNAME, "") ?: ""

        fun getRole(ctx: Context): String =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ROLE, "user") ?: "user"

        fun logout(ctx: Context) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_TOKEN).remove(KEY_USERNAME).remove(KEY_ROLE).apply()
        }

        fun saveAuth(ctx: Context, token: String, username: String, role: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_USERNAME, username)
                .putString(KEY_ROLE, role)
                .apply()
        }

        // HTTP base URL derived from WS URL
        fun httpUrl(): String = BackendConfig.WS_URL
            .replace("wss://", "https://")
            .replace("ws://", "http://")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_auth)

        tabLogin = findViewById(R.id.tab_login)
        tabSignup = findViewById(R.id.tab_signup)
        etUsername = findViewById(R.id.et_auth_username)
        etPassword = findViewById(R.id.et_auth_password)
        etConfirmPassword = findViewById(R.id.et_auth_confirm)
        tvConfirmLabel = findViewById(R.id.tv_confirm_label)
        btnSubmit = findViewById(R.id.btn_auth_submit)
        tvError = findViewById(R.id.tv_auth_error)
        progressBar = findViewById(R.id.auth_progress)
        tvSwitch = findViewById(R.id.tv_auth_switch)

        tabLogin.setOnClickListener { setMode(true) }
        tabSignup.setOnClickListener { setMode(false) }
        tvSwitch.setOnClickListener { setMode(!isLoginMode) }
        btnSubmit.setOnClickListener { submit() }

        setMode(true)
    }

    private fun setMode(login: Boolean) {
        isLoginMode = login
        tabLogin.isSelected = login
        tabSignup.isSelected = !login
        tabLogin.alpha = if (login) 1f else 0.5f
        tabSignup.alpha = if (!login) 1f else 0.5f
        etConfirmPassword.visibility = if (login) View.GONE else View.VISIBLE
        tvConfirmLabel.visibility = if (login) View.GONE else View.VISIBLE
        btnSubmit.text = if (login) "Sign In" else "Create Account"
        tvSwitch.text = if (login) "New to FlowLink? Sign up" else "Already have an account? Sign in"
        tvError.visibility = View.GONE
    }

    private fun submit() {
        val username = etUsername.text.toString().trim()
        val password = etPassword.text.toString()
        val confirm = etConfirmPassword.text.toString()

        tvError.visibility = View.GONE

        if (username.isEmpty() || password.isEmpty()) {
            showError("All fields are required"); return
        }
        if (!isLoginMode && password != confirm) {
            showError("Passwords do not match"); return
        }
        if (!isLoginMode && password.length < 6) {
            showError("Password must be at least 6 characters"); return
        }

        setLoading(true)
        val endpoint = if (isLoginMode) "/auth/login" else "/auth/signup"

        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    val url = URL("${httpUrl()}$endpoint")
                    val conn = url.openConnection() as HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.doOutput = true
                    conn.connectTimeout = 10000
                    conn.readTimeout = 10000
                    val body = JSONObject().apply {
                        put("username", username)
                        put("password", password)
                    }.toString()
                    conn.outputStream.write(body.toByteArray())
                    val code = conn.responseCode
                    val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                    val response = stream.bufferedReader().readText()
                    Pair(code, JSONObject(response))
                }

                val (code, json) = result
                if (code in 200..299) {
                    val token = json.getString("token")
                    val uname = json.getString("username")
                    val role = json.optString("role", "user")
                    saveAuth(this@AuthActivity, token, uname, role)
                    // Also save to SessionManager prefs for compatibility
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .putString("username", uname).apply()
                    startActivity(Intent(this@AuthActivity, MainActivity::class.java))
                    finish()
                } else {
                    showError(json.optString("error", "Authentication failed"))
                }
            } catch (e: Exception) {
                showError("Connection failed: ${e.message}")
            } finally {
                setLoading(false)
            }
        }
    }

    private fun showError(msg: String) {
        tvError.text = msg
        tvError.visibility = View.VISIBLE
    }

    private fun setLoading(loading: Boolean) {
        progressBar.visibility = if (loading) View.VISIBLE else View.GONE
        btnSubmit.isEnabled = !loading
        btnSubmit.text = if (loading) "Please wait…" else if (isLoginMode) "Sign In" else "Create Account"
    }
}
