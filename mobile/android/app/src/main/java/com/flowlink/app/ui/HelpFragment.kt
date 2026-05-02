package com.flowlink.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.flowlink.app.MainActivity
import com.flowlink.app.databinding.FragmentHelpBinding
import org.json.JSONObject

class HelpFragment : Fragment() {
    private var _binding: FragmentHelpBinding? = null
    private val binding get() = _binding!!

    companion object {
        fun newInstance() = HelpFragment()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentHelpBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity
        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        binding.btnSubmitReport.setOnClickListener {
            val text = binding.etReport.text?.toString()?.trim().orEmpty()
            if (text.isEmpty()) {
                Toast.makeText(requireContext(), "Please describe the issue", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            sendFeedback(mainActivity, "report", text)
            binding.etReport.setText("")
            Toast.makeText(requireContext(), "Report submitted. Thank you!", Toast.LENGTH_SHORT).show()
        }

        binding.btnSubmitFeedback.setOnClickListener {
            val text = binding.etFeedback.text?.toString()?.trim().orEmpty()
            if (text.isEmpty()) {
                Toast.makeText(requireContext(), "Please enter your feedback", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            sendFeedback(mainActivity, "feedback", text)
            binding.etFeedback.setText("")
            Toast.makeText(requireContext(), "Feedback sent. Thank you!", Toast.LENGTH_SHORT).show()
        }
    }

    private fun sendFeedback(mainActivity: MainActivity?, type: String, text: String) {
        mainActivity ?: return
        try {
            val username = mainActivity.sessionManager.getUsername()
            val deviceId = mainActivity.sessionManager.getDeviceId()
            mainActivity.webSocketManager.sendMessage(JSONObject().apply {
                put("type", "feedback_submit")
                put("deviceId", deviceId)
                put("payload", JSONObject().apply {
                    put("type", type)
                    put("text", text)
                    put("fromUsername", username)
                })
                put("timestamp", System.currentTimeMillis())
            }.toString())
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to send feedback", e)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
