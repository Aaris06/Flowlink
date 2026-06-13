package com.flowlink.app.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.flowlink.app.databinding.FragmentSettingsBinding

class SettingsFragment : Fragment() {
    private var _binding: FragmentSettingsBinding? = null
    private val binding get() = _binding!!

    /** Currently playing preview ringtone — stopped when user leaves or picks another */
    private var previewRingtone: Ringtone? = null

    private val pickBgLauncher = registerForActivityResult(ActivityResultContracts.GetContent()) { uri: Uri? ->
        uri ?: return@registerForActivityResult
        val prefs = requireContext().getSharedPreferences("flowlink_settings", Context.MODE_PRIVATE)
        prefs.edit().putString("chat_bg_uri", uri.toString()).apply()
        Toast.makeText(requireContext(), "Chat background updated", Toast.LENGTH_SHORT).show()
    }

    /**
     * System ringtone picker — launched when the user taps "Choose Ringtone"
     */
    private val pickRingtoneLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uri = result.data?.getParcelableExtra<Uri>(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)
        val prefs = requireContext().getSharedPreferences("flowlink_settings", Context.MODE_PRIVATE)
        if (uri != null) {
            prefs.edit().putString("ringtone_uri", uri.toString()).apply()
        } else {
            // User picked "None"
            prefs.edit().remove("ringtone_uri").apply()
        }
        updateRingtoneLabel()
    }

    companion object {
        const val PREF_RINGTONE_URI     = "ringtone_uri"
        const val PREF_RINGTONE_ENABLED = "ringtone_enabled"
        const val PREF_RINGTONE_VOLUME  = "ringtone_volume"

        fun newInstance() = SettingsFragment()

        /** Get the saved ringtone URI, or null if silent */
        fun getRingtoneUri(context: Context): Uri? {
            val prefs = context.getSharedPreferences("flowlink_settings", Context.MODE_PRIVATE)
            val enabled = prefs.getBoolean(PREF_RINGTONE_ENABLED, true)
            if (!enabled) return null
            val uriStr = prefs.getString(PREF_RINGTONE_URI, null)
            return when {
                uriStr != null -> Uri.parse(uriStr)
                else -> RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            }
        }

        /** Get the saved ringtone volume (0–15, AudioManager stream scale) */
        fun getRingtoneVolume(context: Context): Int {
            val prefs = context.getSharedPreferences("flowlink_settings", Context.MODE_PRIVATE)
            val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_RING)
            return prefs.getInt(PREF_RINGTONE_VOLUME, (maxVol * 0.8f).toInt())
        }

        /** Play ringtone for an incoming call, returns the Ringtone object so caller can stop it */
        fun playRingtone(context: Context): Ringtone? {
            val uri = getRingtoneUri(context) ?: return null
            return try {
                val rt = RingtoneManager.getRingtone(context, uri) ?: return null
                rt.audioAttributes = android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
                rt.play()
                rt
            } catch (e: Exception) {
                android.util.Log.w("FlowLink", "Failed to play ringtone: ${e.message}")
                null
            }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentSettingsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val prefs = requireContext().getSharedPreferences("flowlink_settings", Context.MODE_PRIVATE)
        val am    = requireContext().getSystemService(Context.AUDIO_SERVICE) as AudioManager

        binding.btnBack.setOnClickListener { stopPreview(); parentFragmentManager.popBackStack() }

        // ── Appearance ──────────────────────────────────────────────────────
        val isDark = prefs.getBoolean("dark_theme", true)
        binding.switchDarkTheme.isChecked = isDark
        binding.switchDarkTheme.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("dark_theme", checked).apply()
            AppCompatDelegate.setDefaultNightMode(
                if (checked) AppCompatDelegate.MODE_NIGHT_YES else AppCompatDelegate.MODE_NIGHT_NO
            )
        }

        // ── Privacy ─────────────────────────────────────────────────────────
        binding.switchReadReceipts.isChecked = prefs.getBoolean("read_receipts", true)
        binding.switchReadReceipts.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("read_receipts", checked).apply()
        }

        binding.switchActiveStatus.isChecked = prefs.getBoolean("active_status", true)
        binding.switchActiveStatus.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("active_status", checked).apply()
        }

        // ── Chat background ─────────────────────────────────────────────────
        binding.btnChatBg.setOnClickListener { pickBgLauncher.launch("image/*") }

        // ── Ringtone enabled switch ──────────────────────────────────────────
        binding.switchRingtone.isChecked = prefs.getBoolean(PREF_RINGTONE_ENABLED, true)
        binding.switchRingtone.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean(PREF_RINGTONE_ENABLED, checked).apply()
            binding.ringtoneControls.visibility = if (checked) View.VISIBLE else View.GONE
            if (!checked) stopPreview()
        }
        binding.ringtoneControls.visibility =
            if (prefs.getBoolean(PREF_RINGTONE_ENABLED, true)) View.VISIBLE else View.GONE

        // ── Ringtone label (shows currently chosen tone name) ────────────────
        updateRingtoneLabel()

        // ── Choose ringtone button ───────────────────────────────────────────
        binding.btnChooseRingtone.setOnClickListener {
            stopPreview()
            val currentUri = prefs.getString(PREF_RINGTONE_URI, null)
                ?.let { Uri.parse(it) }
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

            val intent = android.content.Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
                putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_RINGTONE)
                putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Select Call Ringtone")
                putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, currentUri)
                putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, true)
                putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            }
            pickRingtoneLauncher.launch(intent)
        }

        // ── Preview button ───────────────────────────────────────────────────
        binding.btnPreviewRingtone.setOnClickListener {
            stopPreview()
            val uri = getRingtoneUri(requireContext()) ?: run {
                Toast.makeText(requireContext(), "Ringtone is silent", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            try {
                val rt = RingtoneManager.getRingtone(requireContext(), uri)
                rt?.play()
                previewRingtone = rt
                // Auto-stop after 5 seconds
                binding.root.postDelayed({ stopPreview() }, 5000)
            } catch (e: Exception) {
                Toast.makeText(requireContext(), "Cannot preview: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }

        // ── Volume seekbar ───────────────────────────────────────────────────
        val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_RING)
        val savedVol = prefs.getInt(PREF_RINGTONE_VOLUME, (maxVol * 0.8f).toInt())
        binding.seekRingtoneVolume.max      = maxVol
        binding.seekRingtoneVolume.progress = savedVol
        updateVolumeLabel(savedVol, maxVol)

        binding.seekRingtoneVolume.setOnSeekBarChangeListener(object :
            android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    prefs.edit().putInt(PREF_RINGTONE_VOLUME, progress).apply()
                    updateVolumeLabel(progress, maxVol)
                }
            }
            override fun onStartTrackingTouch(sb: android.widget.SeekBar?) {}
            override fun onStopTrackingTouch(sb: android.widget.SeekBar?) {
                // Brief preview at new volume
                stopPreview()
                val uri = getRingtoneUri(requireContext()) ?: return
                try {
                    val rt = RingtoneManager.getRingtone(requireContext(), uri)
                    rt?.play(); previewRingtone = rt
                    binding.root.postDelayed({ stopPreview() }, 2500)
                } catch (_: Exception) {}
            }
        })
    }

    private fun updateRingtoneLabel() {
        val prefs = requireContext().getSharedPreferences("flowlink_settings", Context.MODE_PRIVATE)
        val enabled = prefs.getBoolean(PREF_RINGTONE_ENABLED, true)
        if (!enabled) {
            _binding?.tvRingtoneName?.text = "Silent"
            return
        }
        val uriStr = prefs.getString(PREF_RINGTONE_URI, null)
        val label = when {
            uriStr == null -> "Default Ringtone"
            else -> {
                try {
                    RingtoneManager.getRingtone(requireContext(), Uri.parse(uriStr))
                        ?.getTitle(requireContext()) ?: "Custom Ringtone"
                } catch (e: Exception) { "Custom Ringtone" }
            }
        }
        _binding?.tvRingtoneName?.text = label
    }

    private fun updateVolumeLabel(progress: Int, max: Int) {
        val pct = if (max > 0) ((progress.toFloat() / max) * 100).toInt() else 0
        _binding?.tvRingtoneVolumePct?.text = "$pct%"
    }

    private fun stopPreview() {
        previewRingtone?.stop()
        previewRingtone = null
    }

    override fun onPause() {
        super.onPause()
        stopPreview()
    }

    override fun onDestroyView() {
        stopPreview()
        super.onDestroyView()
        _binding = null
    }
}
