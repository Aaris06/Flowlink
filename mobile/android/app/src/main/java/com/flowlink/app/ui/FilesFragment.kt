package com.flowlink.app.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.flowlink.app.BuildConfig
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentFilesBinding
import com.flowlink.app.service.SessionManager
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.launch
import java.io.File

class FilesFragment : Fragment() {
    private var _binding: FragmentFilesBinding? = null
    private val binding get() = _binding!!
    private var sessionManager: SessionManager? = null
    private var studyPage = 1
    private var studyFiles = listOf<WebSocketManager.StudyFile>()
    private var filesAdapter: StudyFilesAdapter? = null
    private var isHost = false
    private var syncEnabled = true   // sync toggle state

    private val pickFileLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri ?: return@registerForActivityResult
        val mainActivity = activity as? MainActivity ?: return@registerForActivityResult
        val ctx = requireContext()
        try {
            val resolver = ctx.contentResolver
            val name = resolver.query(uri, null, null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx != -1 && cursor.moveToFirst()) cursor.getString(idx) else uri.lastPathSegment ?: "file"
            } ?: (uri.lastPathSegment ?: "file")
            val type = resolver.getType(uri) ?: "application/octet-stream"
            val size = resolver.query(uri, null, null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                if (idx != -1 && cursor.moveToFirst()) cursor.getLong(idx) else 0L
            } ?: 0L
            mainActivity.webSocketManager.uploadStudyFile(uri, name, type, size)
            Toast.makeText(ctx, "Uploading $name to store", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(ctx, "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        fun newInstance() = FilesFragment()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionManager = SessionManager(requireContext())
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentFilesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return
        val selfId = sessionManager?.getDeviceId()

        // Determine if this device is the session host (first device = host)
        isHost = mainActivity.webSocketManager.sessionDevices.value.isEmpty() ||
                selfId == mainActivity.webSocketManager.sessionDevices.value.firstOrNull()?.id

        binding.rvFiles.layoutManager = LinearLayoutManager(requireContext())
        filesAdapter = StudyFilesAdapter(
            files = mutableListOf(),
            isHost = isHost,
            onOpen = { file ->
                // Broadcast open_pdf to all connected laptops & mobile devices if sync is ON
                if (syncEnabled) mainActivity.webSocketManager.sendStudySync("open_pdf", file.id)
                openFileViewer(file, mainActivity)
            },
            onDownload = { file -> downloadFile(file) },
            onDelete = { file ->
                mainActivity.webSocketManager.deleteStudyFile(file.id)
                Toast.makeText(requireContext(), "Deleted ${file.name}", Toast.LENGTH_SHORT).show()
            }
        )
        binding.rvFiles.adapter = filesAdapter

        binding.btnSelectFiles.setOnClickListener { pickFileLauncher.launch(arrayOf("*/*")) }

        // Sync toggle
        updateSyncToggleUI()
        binding.btnSyncToggle.setOnClickListener {
            syncEnabled = !syncEnabled
            updateSyncToggleUI()
            val msg = if (syncEnabled) "Sync ON — page/scroll synced with all" else "Sync OFF — viewing privately"
            Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
        }

        binding.btnStudyPrev.setOnClickListener {
            studyPage = maxOf(1, studyPage - 1)
            updateStudyStatus()
            if (syncEnabled) mainActivity.webSocketManager.sendStudySync("page", studyPage)
        }
        binding.btnStudyNext.setOnClickListener {
            studyPage += 1
            updateStudyStatus()
            if (syncEnabled) mainActivity.webSocketManager.sendStudySync("page", studyPage)
        }

        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.studyStore.collect { files ->
                studyFiles = files
                filesAdapter?.setFiles(files)
                binding.tvFilesSubtitle.text = "${files.size} file(s) in store"
                (parentFragmentManager.findFragmentByTag("home") as? HomeFragment)?.updateFileCount(files.size)
            }
        }

        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.studySyncEvents.collect { event ->
                if (!syncEnabled) return@collect
                when (event.mode) {
                    "page" -> {
                        val page = when (val v = event.value) {
                            is Number -> v.toInt()
                            is String -> v.toIntOrNull() ?: studyPage
                            else -> studyPage
                        }
                        studyPage = maxOf(1, page)
                        updateStudyStatus()
                    }
                    "open_pdf" -> {
                        val rawVal = event.value?.toString() ?: ""
                        if (rawVal.isBlank() || rawVal == "close") {
                            // Close file if open
                            val currentFrag = parentFragmentManager.findFragmentById(R.id.fragment_container)
                            if (currentFrag is FileViewerFragment) {
                                parentFragmentManager.popBackStack()
                            }
                        } else {
                            val fileId = rawVal
                            val file = studyFiles.firstOrNull { it.id == fileId } ?: return@collect
                            openFileViewer(file, mainActivity)
                        }
                    }
                }
            }
        }

        mainActivity.webSocketManager.requestStudyStore()
        updateStudyStatus()
    }

    private fun openFileViewer(file: WebSocketManager.StudyFile, mainActivity: MainActivity) {
        val fragment = FileViewerFragment.newInstance(file, isHost)
        parentFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, fragment)
            .addToBackStack(null)
            .commit()
    }

    private fun downloadFile(file: WebSocketManager.StudyFile) {
        if (file.data.isEmpty()) {
            Toast.makeText(requireContext(), "No data to download", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val bytes = android.util.Base64.decode(file.data, android.util.Base64.DEFAULT)
            val dir = File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS), "FlowLink")
            dir.mkdirs()
            val outFile = File(dir, file.name)
            outFile.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(requireContext(), "${BuildConfig.APPLICATION_ID}.fileprovider", outFile)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, file.type.ifEmpty { "*/*" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(Intent.createChooser(intent, "Open ${file.name}"))
            Toast.makeText(requireContext(), "Saved to Downloads/FlowLink", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(requireContext(), "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun updateStudyStatus() {
        binding.tvStudyStatus.text = "Page $studyPage"
        binding.tvSyncInfo.text = if (syncEnabled) "Synced with all devices" else "Sync OFF"
    }

    private fun updateSyncToggleUI() {
        binding.btnSyncToggle.setColorFilter(
            android.graphics.Color.parseColor(if (syncEnabled) "#22C55E" else "#6B6890")
        )
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}

class StudyFilesAdapter(
    private val files: MutableList<WebSocketManager.StudyFile>,
    private val isHost: Boolean,
    private val onOpen: (WebSocketManager.StudyFile) -> Unit,
    private val onDownload: (WebSocketManager.StudyFile) -> Unit,
    private val onDelete: (WebSocketManager.StudyFile) -> Unit
) : RecyclerView.Adapter<StudyFilesAdapter.FileViewHolder>() {

    class FileViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val tvFileIcon: TextView = itemView.findViewById(R.id.tv_file_icon)
        val tvFileName: TextView = itemView.findViewById(R.id.tv_file_name)
        val tvFileMeta: TextView = itemView.findViewById(R.id.tv_file_meta)
        val btnDownload: ImageButton = itemView.findViewById(R.id.btn_download_file)
        val btnOpen: ImageButton = itemView.findViewById(R.id.btn_open_file)
        val btnDelete: ImageButton = itemView.findViewById(R.id.btn_delete_file)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): FileViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_study_file, parent, false)
        return FileViewHolder(view)
    }

    override fun onBindViewHolder(holder: FileViewHolder, position: Int) {
        val file = files[position]
        holder.tvFileName.text = file.name
        val sizeKb = maxOf(1, file.size / 1024)
        val ext = file.name.substringAfterLast('.', "").uppercase()
        holder.tvFileMeta.text = if (ext.isNotEmpty()) "$ext · $sizeKb KB" else "$sizeKb KB"
        holder.tvFileIcon.text = when {
            file.name.endsWith(".pdf", true) -> "📄"
            file.name.endsWith(".jpg", true) || file.name.endsWith(".png", true) || file.name.endsWith(".jpeg", true) -> "🖼️"
            file.name.endsWith(".mp4", true) || file.name.endsWith(".mov", true) -> "🎬"
            file.name.endsWith(".mp3", true) || file.name.endsWith(".wav", true) -> "🎵"
            file.name.endsWith(".doc", true) || file.name.endsWith(".docx", true) -> "📝"
            else -> "📁"
        }
        holder.btnDownload.setOnClickListener { onDownload(file) }
        holder.btnOpen.setOnClickListener { onOpen(file) }
        holder.itemView.setOnClickListener { onOpen(file) }
        holder.btnDelete.visibility = if (isHost) View.VISIBLE else View.GONE
        holder.btnDelete.setOnClickListener { onDelete(file) }
    }

    override fun getItemCount() = files.size

    fun setFiles(newFiles: List<WebSocketManager.StudyFile>) {
        files.clear()
        files.addAll(newFiles)
        notifyDataSetChanged()
    }
}
