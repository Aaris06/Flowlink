package com.flowlink.app.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.widget.SwitchCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import kotlinx.coroutines.launch
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

class SessionCreatedFragment : Fragment() {

    private var sessionCode: String? = null
    private var sessionId: String? = null

    companion object {
        fun newInstance(code: String, sessionId: String): SessionCreatedFragment {
            val fragment = SessionCreatedFragment()
            val args = Bundle()
            args.putString("code", code)
            args.putString("sessionId", sessionId)
            fragment.arguments = args
            return fragment
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionCode = arguments?.getString("code")
        sessionId = arguments?.getString("sessionId")
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val view = inflater.inflate(R.layout.fragment_session_created, container, false)
        
        val tvCode = view.findViewById<TextView>(R.id.session_code)
        val ivQrCode = view.findViewById<ImageView>(R.id.qr_code_image)
        val btnDone = view.findViewById<Button>(R.id.done_button)
        val switchNotify = view.findViewById<SwitchCompat>(R.id.switch_notify_friends_only)
        val tvNotifyDesc = view.findViewById<TextView>(R.id.tv_notify_friends_desc)

        // ── Notify friends only toggle ─────────────────────────────────────
        val prefs = requireContext().getSharedPreferences("flowlink_settings", android.content.Context.MODE_PRIVATE)
        switchNotify.isChecked = prefs.getBoolean("notify_friends_only", false)
        tvNotifyDesc.text = if (switchNotify.isChecked) "Notify friends only" else "Notify all active users"
        switchNotify.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean("notify_friends_only", checked).apply()
            tvNotifyDesc.text = if (checked) "Notify friends only" else "Notify all active users"
        }

        sessionCode?.let { code ->
            tvCode.text = code
            
            // Generate QR code
            try {
                val writer = QRCodeWriter()
                val hints = hashMapOf<EncodeHintType, Any>().apply {
                    put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.H)
                    put(EncodeHintType.CHARACTER_SET, "UTF-8")
                }
                val bitMatrix = writer.encode(code, BarcodeFormat.QR_CODE, 512, 512, hints)
                val width = bitMatrix.width
                val height = bitMatrix.height
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
                
                for (x in 0 until width) {
                    for (y in 0 until height) {
                        bitmap.setPixel(x, y, if (bitMatrix[x, y]) Color.BLACK else Color.WHITE)
                    }
                }
                
                ivQrCode.setImageBitmap(bitmap)
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Failed to generate QR code", e)
            }
        }

        // Listen for device connections and navigate to device tiles when a device joins
        // Keep QR code visible until a device connects
        val mainActivity = activity as? MainActivity
        if (mainActivity != null && sessionId != null) {
            var hasNavigated = false
            
            // Listen only while this view is active so backstack fragments do not re-navigate
            viewLifecycleOwner.lifecycleScope.launch {
                mainActivity.webSocketManager.deviceConnectedEvents.collect { _ ->
                    if (!hasNavigated) {
                        hasNavigated = true
                        sessionId?.let { id ->
                            (activity as? MainActivity)?.showDeviceTiles(id)
                        }
                    }
                }
            }
        }

        btnDone.setOnClickListener {
            sessionId?.let { id ->
                (activity as? MainActivity)?.showDeviceTiles(id)
            } ?: run {
                // If no session ID, go back to session manager
                (activity as? MainActivity)?.leaveSession()
            }
        }

        return view
    }
}
