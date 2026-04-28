package com.flowlink.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.flowlink.app.databinding.FragmentPermissionsBinding

class PermissionsFragment : Fragment() {
    private var _binding: FragmentPermissionsBinding? = null
    private val binding get() = _binding!!

    private val requestMultiple = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { updateStatuses() }

    companion object {
        fun newInstance() = PermissionsFragment()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentPermissionsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        binding.btnNotifPermission.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestMultiple.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            } else {
                Toast.makeText(requireContext(), "Notifications enabled by default on this Android version", Toast.LENGTH_SHORT).show()
            }
        }
        binding.btnCameraPermission.setOnClickListener {
            requestMultiple.launch(arrayOf(Manifest.permission.CAMERA))
        }
        binding.btnStoragePermission.setOnClickListener {
            val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_AUDIO)
            } else {
                arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE)
            }
            requestMultiple.launch(perms)
        }
        binding.btnMicPermission.setOnClickListener {
            requestMultiple.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
        }

        updateStatuses()
    }

    private fun updateStatuses() {
        val ctx = requireContext()
        fun granted(p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            granted(Manifest.permission.POST_NOTIFICATIONS) else true
        binding.tvNotifStatus.text = if (notifGranted) "✅ Granted" else "❌ Not granted"
        binding.switchNotifPermission.isChecked = notifGranted
        binding.switchNotifPermission.isEnabled = !notifGranted
        binding.btnNotifPermission.visibility = if (notifGranted) View.GONE else View.VISIBLE

        val cameraGranted = granted(Manifest.permission.CAMERA)
        binding.tvCameraStatus.text = if (cameraGranted) "✅ Granted" else "❌ Not granted"
        binding.switchCameraPermission.isChecked = cameraGranted
        binding.switchCameraPermission.isEnabled = !cameraGranted
        binding.btnCameraPermission.visibility = if (cameraGranted) View.GONE else View.VISIBLE

        val storageGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            granted(Manifest.permission.READ_MEDIA_IMAGES)
        else granted(Manifest.permission.READ_EXTERNAL_STORAGE)
        binding.tvStorageStatus.text = if (storageGranted) "✅ Granted" else "❌ Not granted"
        binding.switchStoragePermission.isChecked = storageGranted
        binding.switchStoragePermission.isEnabled = !storageGranted
        binding.btnStoragePermission.visibility = if (storageGranted) View.GONE else View.VISIBLE

        val micGranted = granted(Manifest.permission.RECORD_AUDIO)
        binding.tvMicStatus.text = if (micGranted) "✅ Granted" else "❌ Not granted"
        binding.switchMicPermission.isChecked = micGranted
        binding.switchMicPermission.isEnabled = !micGranted
        binding.btnMicPermission.visibility = if (micGranted) View.GONE else View.VISIBLE
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
