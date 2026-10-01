package com.flowlink.app.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.ImageView
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.BuildConfig
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentFileViewerBinding
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

class FileViewerFragment : Fragment() {
    private var _binding: FragmentFileViewerBinding? = null
    private val binding get() = _binding!!

    private var fileId: String = ""
    private var fileName: String = ""
    private var fileType: String = ""
    private var fileData: String = ""
    private var currentPage = 1
    private var totalPages = 1
    private var isHost = false
    private var syncEnabled = true
    private var pdfRenderer: PdfRenderer? = null
    private var pdfFile: File? = null
    private var scrollSyncTimer: Runnable? = null
    private var suppressScrollSync = false
    private var scrollChangedListener: android.view.ViewTreeObserver.OnScrollChangedListener? = null

    companion object {
        fun newInstance(file: WebSocketManager.StudyFile, isHost: Boolean): FileViewerFragment {
            return FileViewerFragment().apply {
                arguments = Bundle().apply {
                    putString("file_id", file.id)
                    putString("file_name", file.name)
                    putString("file_type", file.type)
                    putString("file_data", file.data)
                    putBoolean("is_host", isHost)
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        fileId = arguments?.getString("file_id") ?: ""
        fileName = arguments?.getString("file_name") ?: ""
        fileType = arguments?.getString("file_type") ?: ""
        fileData = arguments?.getString("file_data") ?: ""
        isHost = arguments?.getBoolean("is_host") ?: false
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentFileViewerBinding.inflate(inflater, container, false)
        return binding.root
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return

        binding.tvFileTitle.text = fileName
        binding.btnBack.setOnClickListener {
            // Broadcast close event to all connected devices if sync is ON
            if (syncEnabled) mainActivity.webSocketManager.sendStudySync("open_pdf", "close")
            parentFragmentManager.popBackStack()
        }
        binding.btnDownload.setOnClickListener { downloadFile() }

        // Sync toggle
        updateSyncToggleUI()
        binding.btnHighlight.setOnClickListener {
            syncEnabled = !syncEnabled
            updateSyncToggleUI()
            Toast.makeText(requireContext(),
                if (syncEnabled) "Sync ON" else "Sync OFF",
                Toast.LENGTH_SHORT).show()
        }

        // Page controls
        binding.btnPrevPage.setOnClickListener {
            if (currentPage > 1) {
                currentPage--
                renderCurrentPage()
                if (syncEnabled) mainActivity.webSocketManager.sendStudySync("page", currentPage)
            }
        }
        binding.btnNextPage.setOnClickListener {
            if (currentPage < totalPages) {
                currentPage++
                renderCurrentPage()
                if (syncEnabled) mainActivity.webSocketManager.sendStudySync("page", currentPage)
            }
        }

        // Debounced scroll sync
        scrollChangedListener = android.view.ViewTreeObserver.OnScrollChangedListener {
            val b = _binding ?: return@OnScrollChangedListener
            if (!syncEnabled || suppressScrollSync) return@OnScrollChangedListener
            scrollSyncTimer?.let { b.root.removeCallbacks(it) }
            val r = Runnable {
                _binding?.let { bd -> mainActivity.webSocketManager.sendStudySync("scroll_px", bd.scrollContent.scrollY) }
            }
            scrollSyncTimer = r
            b.root.postDelayed(r, 400)
        }
        binding.scrollContent.viewTreeObserver.addOnScrollChangedListener(scrollChangedListener)

        // WebView JS bridge
        binding.wvContent.settings.javaScriptEnabled = true
        binding.wvContent.addJavascriptInterface(object : Any() {
            @JavascriptInterface
            fun onTextSelected(text: String) {
                if (syncEnabled && text.isNotBlank()) {
                    activity?.runOnUiThread {
                        mainActivity.webSocketManager.sendStudySync("highlight", text.take(200))
                    }
                }
            }
        }, "FlowLinkBridge")

        // Observe sync events from other devices
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.studySyncEvents.collect { event ->
                // STRICT CHECK: IF SYNC IS TURNED OFF ON MOBILE, IGNORE ALL REMOTE EVENTS
                if (!syncEnabled) return@collect

                when (event.mode) {
                    "open_pdf" -> {
                        val valObj = event.value
                        var newId = ""
                        if (valObj is String) {
                            newId = valObj
                        } else if (valObj is JSONObject) {
                            newId = valObj.optString("fileId", valObj.optString("id", ""))
                        }
                        if (newId.isBlank() || newId == "close") {
                            // File closed on remote — close viewer
                            parentFragmentManager.popBackStack()
                        } else if (newId != fileId) {
                            fileId = newId
                            binding.tvFileTitle.text = "Syncing Document…"
                        }
                    }
                    "page" -> {
                        val page = when (val v = event.value) {
                            is Number -> v.toInt()
                            is String -> v.toIntOrNull() ?: currentPage
                            else -> currentPage
                        }
                        currentPage = page.coerceIn(1, totalPages)
                        renderCurrentPage()
                    }
                    "scroll_px" -> {
                        val px = (event.value as? Number)?.toInt() ?: 0
                        suppressScrollSync = true
                        binding.scrollContent.smoothScrollTo(0, px)
                        binding.root.postDelayed({ suppressScrollSync = false }, 600)
                    }
                    "highlight" -> {
                        val text = event.value?.toString() ?: ""
                        binding.tvHighlightInfo.text = "📌 Note: \"${text.take(50)}\""
                        if (binding.wvContent.visibility == View.VISIBLE) {
                            highlightTextInWebView(text)
                        }
                    }
                }
            }
        }

        // Notify others this file is open if sync is ON
        if (syncEnabled) mainActivity.webSocketManager.sendStudySync("open_pdf", fileId)

        viewLifecycleOwner.lifecycleScope.launch { renderContent() }
    }

    private fun updateSyncToggleUI() {
        val color = if (syncEnabled) "#22C55E" else "#6B6890"
        binding.btnHighlight.text = if (syncEnabled) "Sync ON" else "Sync OFF"
        binding.btnHighlight.setBackgroundColor(android.graphics.Color.parseColor(
            if (syncEnabled) "#1A22C55E" else "#1A6B6890"
        ))
        binding.tvSyncBadge.text = if (syncEnabled) "● Synced" else "○ Sync OFF"
        binding.tvSyncBadge.setTextColor(android.graphics.Color.parseColor(color))
        binding.tvHighlightInfo.text = if (syncEnabled) "● Syncing with session" else "○ Sync OFF"
        binding.tvHighlightInfo.setTextColor(android.graphics.Color.parseColor(color))
    }

    private fun highlightTextInWebView(text: String) {
        val escaped = text.replace("\\", "\\\\").replace("'", "\\'")
        binding.wvContent.evaluateJavascript("""
            (function(){
                var body=document.body,txt='$escaped';
                var walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);
                while(walker.nextNode()){
                    var idx=walker.currentNode.textContent.indexOf(txt);
                    if(idx>=0){
                        var r=document.createRange();
                        r.setStart(walker.currentNode,idx);
                        r.setEnd(walker.currentNode,idx+txt.length);
                        window.getSelection().removeAllRanges();
                        window.getSelection().addRange(r);
                        walker.currentNode.parentElement.scrollIntoView({behavior:'smooth',block:'center'});
                        break;
                    }
                }
            })();
        """.trimIndent(), null)
    }

    private suspend fun renderContent() {
        if (fileData.isEmpty()) { withContext(Dispatchers.Main) { showUnsupported() }; return }
        try {
            val bytes = Base64.decode(fileData, Base64.DEFAULT)
            when {
                fileType.startsWith("image/") -> withContext(Dispatchers.Main) {
                    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    binding.ivContent.setImageBitmap(bmp)
                    binding.ivContent.visibility = View.VISIBLE
                    binding.wvContent.visibility = View.GONE
                    binding.tvContent.visibility = View.GONE
                    binding.llUnsupported.visibility = View.GONE
                }
                fileType == "text/plain" || fileName.endsWith(".txt", true) -> withContext(Dispatchers.Main) {
                    binding.tvContent.text = String(bytes, Charsets.UTF_8)
                    binding.tvContent.visibility = View.VISIBLE
                    binding.ivContent.visibility = View.GONE
                    binding.wvContent.visibility = View.GONE
                    binding.llUnsupported.visibility = View.GONE
                }
                fileType == "application/pdf" || fileName.endsWith(".pdf", true) -> renderPdf(bytes)
                else -> withContext(Dispatchers.Main) { showUnsupported() }
            }
        } catch (e: Exception) {
            withContext(Dispatchers.Main) { showUnsupported() }
        }
    }

    private suspend fun renderPdf(bytes: ByteArray) {
        withContext(Dispatchers.IO) {
            try {
                val tmpFile = File(requireContext().cacheDir, "viewer_${System.currentTimeMillis()}.pdf")
                tmpFile.writeBytes(bytes)
                pdfFile = tmpFile
                val pfd = ParcelFileDescriptor.open(tmpFile, ParcelFileDescriptor.MODE_READ_ONLY)
                val renderer = PdfRenderer(pfd)
                pdfRenderer = renderer
                totalPages = renderer.pageCount
                withContext(Dispatchers.Main) {
                    binding.wvContent.visibility = View.GONE
                    binding.tvContent.visibility = View.GONE
                    binding.ivContent.visibility = View.VISIBLE
                    binding.llUnsupported.visibility = View.GONE
                    updatePageInfo()
                    renderCurrentPage()
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { showUnsupported() }
            }
        }
    }

    private fun renderCurrentPage() {
        val renderer = pdfRenderer ?: return
        updatePageInfo()
        try {
            val page = renderer.openPage(currentPage - 1)
            val scale = resources.displayMetrics.density * 2f
            val width = (page.width * scale).toInt()
            val height = (page.height * scale).toInt()
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            page.close()
            binding.ivContent.setImageBitmap(bitmap)
            binding.ivContent.scaleType = ImageView.ScaleType.FIT_CENTER
            binding.ivContent.adjustViewBounds = true
        } catch (e: Exception) {
            Toast.makeText(requireContext(), "Failed to render page", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showUnsupported() {
        binding.tvUnsupportedName.text = fileName
        binding.llUnsupported.visibility = View.VISIBLE
        binding.ivContent.visibility = View.GONE
        binding.tvContent.visibility = View.GONE
        binding.wvContent.visibility = View.GONE
    }

    private fun updatePageInfo() {
        binding.tvPageInfo.text = "Page $currentPage / $totalPages"
    }

    private fun downloadFile() {
        if (fileData.isEmpty()) { Toast.makeText(requireContext(), "No data", Toast.LENGTH_SHORT).show(); return }
        try {
            val bytes = Base64.decode(fileData, Base64.DEFAULT)
            val dir = File(android.os.Environment.getExternalStoragePublicDirectory(
                android.os.Environment.DIRECTORY_DOWNLOADS), "FlowLink")
            dir.mkdirs()
            val file = File(dir, fileName)
            file.writeBytes(bytes)
            val uri = FileProvider.getUriForFile(requireContext(), "${BuildConfig.APPLICATION_ID}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, fileType.ifEmpty { "*/*" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(Intent.createChooser(intent, "Open $fileName"))
            Toast.makeText(requireContext(), "Saved to Downloads/FlowLink", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(requireContext(), "Download failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() {
        scrollChangedListener?.let { listener ->
            try { _binding?.scrollContent?.viewTreeObserver?.removeOnScrollChangedListener(listener) } catch (_: Exception) {}
        }
        scrollSyncTimer?.let { runnable ->
            try { _binding?.root?.removeCallbacks(runnable) } catch (_: Exception) {}
        }
        pdfRenderer?.close()
        pdfFile?.delete()
        super.onDestroyView()
        _binding = null
    }
}
