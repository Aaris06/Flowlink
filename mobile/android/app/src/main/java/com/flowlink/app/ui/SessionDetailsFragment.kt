package com.flowlink.app.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.flowlink.app.MainActivity
import com.flowlink.app.databinding.FragmentSessionDetailsBinding
import com.flowlink.app.service.SessionManager
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

class SessionDetailsFragment : Fragment() {
    private var _binding: FragmentSessionDetailsBinding? = null
    private val binding get() = _binding!!

    companion object {
        fun newInstance() = SessionDetailsFragment()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentSessionDetailsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return
        val sm = SessionManager(requireContext())

        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        val code = sm.getCurrentSessionCode() ?: "------"
        binding.tvSessionCode.text = code
        binding.tvSessionCodeQr.text = code
        binding.tvUsername.text = sm.getUsername()
        binding.tvDeviceName.text = sm.getDeviceName()
        binding.tvDeviceCount.text = mainActivity.webSocketManager.sessionDevices.value.size.toString()

        // Generate QR
        try {
            val writer = QRCodeWriter()
            val hints = hashMapOf<EncodeHintType, Any>().apply {
                put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.H)
                put(EncodeHintType.CHARACTER_SET, "UTF-8")
            }
            val matrix = writer.encode(code, BarcodeFormat.QR_CODE, 400, 400, hints)
            val bmp = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565)
            for (x in 0 until matrix.width) for (y in 0 until matrix.height)
                bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
            binding.ivQrCode.setImageBitmap(bmp)
        } catch (_: Exception) {}
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
