package com.flowlink.app.ui

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.databinding.FragmentAdminBinding
import com.flowlink.app.service.BackendConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class AdminFragment : Fragment() {
    private var _binding: FragmentAdminBinding? = null
    private val binding get() = _binding!!

    private val ADMIN_SECRET = "flowlink_admin_2024"
    private var currentTab = "users"
    private var announceType = "info"

    companion object {
        fun newInstance() = AdminFragment()
    }

    private fun httpUrl() = BackendConfig.WS_URL
        .replace("wss://", "https://")
        .replace("ws://", "http://")

    private fun authToken() = AuthActivity.getToken(requireContext()) ?: ""

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentAdminBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        // Tab clicks
        binding.tabUsers.setOnClickListener { switchTab("users") }
        binding.tabSessions.setOnClickListener { switchTab("sessions") }
        binding.tabFeedback.setOnClickListener { switchTab("feedback") }
        binding.tabAnnounce.setOnClickListener { switchTab("announce") }

        // Refresh buttons
        binding.btnRefreshUsers.setOnClickListener { loadUsers() }
        binding.btnRefreshSessions.setOnClickListener { loadSessions() }
        binding.btnRefreshFeedback.setOnClickListener { loadFeedback() }

        // Announce type selector
        binding.typeInfo.setOnClickListener { setAnnounceType("info") }
        binding.typeUpdate.setOnClickListener { setAnnounceType("update") }
        binding.typeWarning.setOnClickListener { setAnnounceType("warning") }

        // Send announcement
        binding.btnSendAnnounce.setOnClickListener { sendAnnouncement() }

        // Load initial data
        loadUsers()
    }

    private fun switchTab(tab: String) {
        currentTab = tab
        // Update tab visuals
        val tabs = listOf(binding.tabUsers, binding.tabSessions, binding.tabFeedback, binding.tabAnnounce)
        val tabIds = listOf("users", "sessions", "feedback", "announce")
        tabs.forEachIndexed { i, tv ->
            if (tabIds[i] == tab) {
                tv.setTextColor(Color.WHITE)
                tv.setBackgroundResource(com.flowlink.app.R.drawable.share_fab_bg)
            } else {
                tv.setTextColor(Color.parseColor("#6B6890"))
                tv.setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg_dark)
            }
        }
        // Show/hide panels
        _binding?.panelUsers?.visibility = if (tab == "users") View.VISIBLE else View.GONE
        _binding?.panelSessions?.visibility = if (tab == "sessions") View.VISIBLE else View.GONE
        _binding?.panelFeedback?.visibility = if (tab == "feedback") View.VISIBLE else View.GONE
        _binding?.panelAnnounce?.visibility = if (tab == "announce") View.VISIBLE else View.GONE

        when (tab) {
            "sessions" -> loadSessions()
            "feedback" -> loadFeedback()
        }
    }

    private fun setAnnounceType(type: String) {
        announceType = type
        val types = mapOf("info" to binding.typeInfo, "update" to binding.typeUpdate, "warning" to binding.typeWarning)
        types.forEach { (t, tv) ->
            if (t == type) {
                tv.setTextColor(Color.WHITE)
                tv.setBackgroundResource(com.flowlink.app.R.drawable.share_fab_bg)
            } else {
                tv.setTextColor(Color.parseColor("#6B6890"))
                tv.setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg_dark)
            }
        }
    }

    private fun showMsg(msg: String) {
        _binding?.tvAdminMsg?.text = msg
        _binding?.tvAdminMsg?.visibility = View.VISIBLE
    }

    private fun setLoading(loading: Boolean) {
        _binding?.adminProgress?.visibility = if (loading) View.VISIBLE else View.GONE
    }

    // ── API helpers ────────────────────────────────────────────────────────
    private suspend fun apiGet(path: String): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val url = URL("${httpUrl()}$path")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.setRequestProperty("x-admin-secret", ADMIN_SECRET)
            conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
            conn.connectTimeout = 8000; conn.readTimeout = 8000
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream).bufferedReader().readText()
            JSONObject(text)
        } catch (e: Exception) { null }
    }

    private suspend fun apiDelete(path: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val url = URL("${httpUrl()}$path")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "DELETE"
            conn.setRequestProperty("x-admin-secret", ADMIN_SECRET)
            conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
            conn.connectTimeout = 8000; conn.readTimeout = 8000
            conn.responseCode in 200..299
        } catch (e: Exception) { false }
    }

    private suspend fun apiPost(path: String, body: JSONObject): JSONObject? = withContext(Dispatchers.IO) {
        try {
            val url = URL("${httpUrl()}$path")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("x-admin-secret", ADMIN_SECRET)
            conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
            conn.doOutput = true; conn.connectTimeout = 8000; conn.readTimeout = 8000
            conn.outputStream.write(body.toString().toByteArray())
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream).bufferedReader().readText()
            JSONObject(text)
        } catch (e: Exception) { null }
    }

    // ── Load Users ─────────────────────────────────────────────────────────
    private fun loadUsers() {
        setLoading(true)
        lifecycleScope.launch {
            val data = apiGet("/admin/devices")
            setLoading(false)
            if (data == null) { showMsg("Failed to load users"); return@launch }
            val users = data.optJSONArray("devices") ?: JSONArray()
            _binding?.listUsers?.removeAllViews() ?: return@launch
            _binding?.tvUsersTitle?.text = "Registered Users (${users.length()})"
            if (users.length() == 0) {
                addEmptyView(_binding?.listUsers, "No users yet")
                return@launch
            }
            for (i in 0 until users.length()) {
                val u = users.getJSONObject(i)
                addUserRow(u)
            }
        }
    }

    private fun addUserRow(u: JSONObject) {
        val ctx = requireContext()
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(12, 12, 12, 12)
            setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg_dark)
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = 8
            layoutParams = lp
        }
        val dot = View(ctx).apply {
            val lp = LinearLayout.LayoutParams(12, 12)
            lp.marginEnd = 10; lp.topMargin = 4
            layoutParams = lp
            setBackgroundColor(if (u.optBoolean("online")) Color.parseColor("#22C55E") else Color.parseColor("#6B7280"))
        }
        val info = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val name = TextView(ctx).apply {
            val role = u.optString("role", "user")
            text = "${u.optString("username")}${if (role == "admin") " 👑" else ""}"
            setTextColor(Color.WHITE); textSize = 14f; setTypeface(null, android.graphics.Typeface.BOLD)
        }
        val meta = TextView(ctx).apply {
            val lastSeen = u.optString("lastSeen", "")
            val inactive = u.optBoolean("inactive")
            text = "Last seen: ${lastSeen.take(16).replace("T", " ")}${if (inactive) " · Inactive 7d+" else ""}"
            setTextColor(Color.parseColor("#6B6890")); textSize = 11f
        }
        info.addView(name); info.addView(meta)
        val isActive = u.optBoolean("isActive", true)
        val btn = Button(ctx).apply {
            text = if (isActive) "Deactivate" else "Inactive"
            setTextColor(Color.parseColor("#EF4444"))
            textSize = 11f; isAllCaps = false
            setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg)
            isEnabled = isActive
            setOnClickListener {
                val id = u.optString("id")
                lifecycleScope.launch {
                    val ok = apiDelete("/admin/devices/$id")
                    if (ok) { showMsg("Account deactivated"); loadUsers() }
                    else showMsg("Failed to deactivate")
                }
            }
        }
        row.addView(dot); row.addView(info); row.addView(btn)
        _binding?.listUsers?.addView(row)
    }

    // ── Load Sessions ──────────────────────────────────────────────────────
    private fun loadSessions() {
        setLoading(true)
        lifecycleScope.launch {
            val data = apiGet("/admin/sessions")
            setLoading(false)
            if (data == null) { showMsg("Failed to load sessions"); return@launch }
            val sessions = data.optJSONArray("sessions") ?: JSONArray()
            _binding?.listSessions?.removeAllViews() ?: return@launch
            if (sessions.length() == 0) { addEmptyView(_binding?.listSessions, "No active sessions"); return@launch }
            for (i in 0 until sessions.length()) addSessionRow(sessions.getJSONObject(i))
        }
    }

    private fun addSessionRow(s: JSONObject) {
        val ctx = requireContext()
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(12, 12, 12, 12)
            setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg_dark)
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = 8; layoutParams = lp
        }
        val header = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        val title = TextView(ctx).apply {
            val reports = s.optInt("reportCount", 0)
            text = "Session ${s.optString("code")}${if (reports > 0) " ⚠ $reports report(s)" else ""}"
            setTextColor(Color.WHITE); textSize = 14f; setTypeface(null, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val terminateBtn = Button(ctx).apply {
            text = "Terminate"; setTextColor(Color.parseColor("#EF4444"))
            textSize = 11f; isAllCaps = false
            setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg)
            setOnClickListener {
                val id = s.optString("id")
                lifecycleScope.launch {
                    val ok = apiDelete("/admin/sessions/$id")
                    if (ok) { showMsg("Session terminated"); loadSessions() }
                    else showMsg("Failed to terminate")
                }
            }
        }
        header.addView(title); header.addView(terminateBtn)
        val meta = TextView(ctx).apply {
            text = "By: ${s.optString("createdBy")} · ${s.optInt("deviceCount")} device(s)"
            setTextColor(Color.parseColor("#6B6890")); textSize = 11f
        }
        card.addView(header); card.addView(meta)
        _binding?.listSessions?.addView(card)
    }

    // ── Load Feedback ──────────────────────────────────────────────────────
    private fun loadFeedback() {
        setLoading(true)
        lifecycleScope.launch {
            val data = apiGet("/admin/feedback")
            setLoading(false)
            if (data == null) { showMsg("Failed to load feedback"); return@launch }
            val items = data.optJSONArray("feedback") ?: JSONArray()
            _binding?.listFeedback?.removeAllViews() ?: return@launch
            if (items.length() == 0) { addEmptyView(_binding?.listFeedback, "No feedback yet"); return@launch }
            for (i in 0 until items.length()) addFeedbackRow(items.getJSONObject(i), i)
        }
    }

    private fun addFeedbackRow(f: JSONObject, idx: Int) {
        val ctx = requireContext()
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(12, 12, 12, 12)
            setBackgroundResource(com.flowlink.app.R.drawable.glass_card_bg_dark)
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = 8; layoutParams = lp
        }
        val header = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        val type = f.optString("type", "feedback")
        val typeLabel = TextView(ctx).apply {
            text = when (type) { "report" -> "🚨 Report"; "session_report" -> "⚠ Session"; else -> "💬 Feedback" }
            setTextColor(if (type == "report" || type == "session_report") Color.parseColor("#FCA5A5") else Color.parseColor("#A78BFA"))
            textSize = 12f; setTypeface(null, android.graphics.Typeface.BOLD)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val from = TextView(ctx).apply {
            text = "from ${f.optString("fromUsername", "unknown")}"
            setTextColor(Color.parseColor("#6B6890")); textSize = 11f
        }
        val deleteBtn = TextView(ctx).apply {
            text = "✕"; setTextColor(Color.parseColor("#6B6890")); textSize = 16f; setPadding(8, 0, 0, 0)
            setOnClickListener {
                lifecycleScope.launch {
                    apiDelete("/admin/feedback/$idx")
                    loadFeedback()
                }
            }
        }
        header.addView(typeLabel); header.addView(from); header.addView(deleteBtn)
        val text = TextView(ctx).apply {
            this.text = f.optString("text", "")
            setTextColor(Color.WHITE); textSize = 13f
            setPadding(0, 6, 0, 0)
        }
        card.addView(header); card.addView(text)
        _binding?.listFeedback?.addView(card)
    }

    // ── Send Announcement ──────────────────────────────────────────────────
    private fun sendAnnouncement() {
        val title = _binding?.etAnnounceTitle?.text?.toString()?.trim() ?: ""
        val msg = _binding?.etAnnounceMsg?.text?.toString()?.trim() ?: ""
        if (title.isEmpty() || msg.isEmpty()) { showMsg("Title and message are required"); return }
        setLoading(true)
        lifecycleScope.launch {
            val body = JSONObject().apply { put("title", title); put("message", msg); put("type", announceType) }
            val result = apiPost("/admin/announce", body)
            setLoading(false)
            if (result?.optBoolean("success") == true) {
                showMsg("✅ Sent to ${result.optInt("reached")} connected devices")
                _binding?.etAnnounceTitle?.setText("")
                _binding?.etAnnounceMsg?.setText("")
            } else {
                showMsg("Failed to send announcement")
            }
        }
    }

    private fun addEmptyView(container: LinearLayout?, text: String) {
        container ?: return
        val tv = TextView(requireContext()).apply {
            this.text = text; setTextColor(Color.parseColor("#6B6890"))
            textSize = 13f; gravity = android.view.Gravity.CENTER
            setPadding(0, 24, 0, 24)
        }
        container.addView(tv)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
