package com.flowlink.app.ui

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.DialogFragment
import com.flowlink.app.R
import org.json.JSONObject

/**
 * Invitation Dialog Fragment
 * 
 * Shows a dialog for sending invitations and broadcasting to nearby devices
 */
class InvitationDialogFragment : DialogFragment() {
    
    interface InvitationDialogListener {
        fun sendInvitation(targetUser: String, message: String?)
        fun broadcastNearby()
        fun getSessionCode(): String
        fun getSessionId(): String
    }
    
    private var listener: InvitationDialogListener? = null
    private lateinit var targetUserInput: EditText
    private lateinit var messageInput: EditText
    private lateinit var sessionCodeText: TextView
    private lateinit var sendInvitationButton: Button
    private lateinit var broadcastButton: Button
    private lateinit var copyCodeButton: Button
    
    override fun onAttach(context: Context) {
        super.onAttach(context)
        try {
            listener = context as InvitationDialogListener
        } catch (e: ClassCastException) {
            throw ClassCastException("$context must implement InvitationDialogListener")
        }
    }
    
    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val dialog = super.onCreateDialog(savedInstanceState)
        dialog.setCanceledOnTouchOutside(true)
        return dialog
    }

    override fun onStart() {
        super.onStart()
        // Make the dialog fill ~92% of screen width so content never collapses
        dialog?.window?.setLayout(
            (resources.displayMetrics.widthPixels * 0.92f).toInt(),
            android.view.ViewGroup.LayoutParams.WRAP_CONTENT
        )
        // Transparent window background so our dialog_background drawable shows properly
        dialog?.window?.setBackgroundDrawableResource(android.R.color.transparent)
    }
    
    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? {
        return inflater.inflate(R.layout.fragment_invitation_dialog, container, false)
    }
    
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        
        targetUserInput = view.findViewById(R.id.target_user_input)
        messageInput = view.findViewById(R.id.message_input)
        sessionCodeText = view.findViewById(R.id.session_code_text)
        sendInvitationButton = view.findViewById(R.id.send_invitation_button)
        broadcastButton = view.findViewById(R.id.broadcast_button)
        copyCodeButton = view.findViewById(R.id.copy_code_button)
        
        // Set session code
        sessionCodeText.text = listener?.getSessionCode() ?: ""
        
        sendInvitationButton.setOnClickListener {
            sendInvitation()
        }
        
        broadcastButton.setOnClickListener {
            broadcastNearby()
        }
        
        copyCodeButton.setOnClickListener {
            copySessionCode()
        }
        
        view.findViewById<Button>(R.id.close_button).setOnClickListener {
            dismiss()
        }
    }
    
    private fun sendInvitation() {
        val targetUser = targetUserInput.text.toString().trim()
        val message = messageInput.text.toString().trim()
        
        if (targetUser.isEmpty()) {
            Toast.makeText(context, "Please enter a username or device ID", Toast.LENGTH_SHORT).show()
            return
        }
        
        listener?.sendInvitation(targetUser, message.ifEmpty { null })
        
        // Clear form and dismiss
        targetUserInput.text.clear()
        messageInput.text.clear()
        dismiss()
        
        Toast.makeText(context, "Invitation sent to $targetUser", Toast.LENGTH_SHORT).show()
    }
    
    private fun broadcastNearby() {
        listener?.broadcastNearby()
        dismiss()
        Toast.makeText(context, "Broadcasting to nearby devices", Toast.LENGTH_SHORT).show()
    }
    
    private fun copySessionCode() {
        val sessionCode = listener?.getSessionCode() ?: return
        val clipboard = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = android.content.ClipData.newPlainText("Session Code", sessionCode)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(context, "Session code copied to clipboard", Toast.LENGTH_SHORT).show()
    }
    
    companion object {
        const val TAG = "InvitationDialogFragment"
        
        fun newInstance(): InvitationDialogFragment {
            return InvitationDialogFragment()
        }
    }
}