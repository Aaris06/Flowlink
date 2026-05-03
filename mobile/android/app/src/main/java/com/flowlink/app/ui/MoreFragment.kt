package com.flowlink.app.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentMoreBinding
import com.flowlink.app.service.SessionManager

class MoreFragment : Fragment() {
    private var _binding: FragmentMoreBinding? = null
    private val binding get() = _binding!!
    private var sessionManager: SessionManager? = null

    companion object {
        fun newInstance() = MoreFragment()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionManager = SessionManager(requireContext())
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMoreBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return

        // Navigation to sub-screens
        binding.moreGroups.setOnClickListener { navigateTo(GroupsFragment.newInstance()) }
        binding.moreSessionDetails.setOnClickListener { navigateTo(SessionDetailsFragment.newInstance()) }
        binding.moreInbox.setOnClickListener {
            // Clear unread count when opening inbox
            requireContext().getSharedPreferences("flowlink_inbox", android.content.Context.MODE_PRIVATE)
                .edit().putBoolean("all_read", true).apply()
            binding.moreInbox.text = "📬   Inbox"
            navigateTo(InboxFragment.newInstance())
        }
        binding.moreBrowser.setOnClickListener { navigateTo(BrowserFragment.newInstance()) }
        binding.moreFriends.setOnClickListener { navigateTo(FriendsFragment.newInstance()) }
        binding.morePermissions.setOnClickListener { navigateTo(PermissionsFragment.newInstance()) }
        binding.moreSettings.setOnClickListener { navigateTo(SettingsFragment.newInstance()) }
        binding.moreHelp.setOnClickListener { navigateTo(HelpFragment.newInstance()) }
        binding.moreAbout.setOnClickListener { navigateTo(AboutFragment.newInstance()) }
        binding.moreLeaveSession.setOnClickListener { mainActivity.leaveSession() }

        // Show admin panel only for admin role
        val role = com.flowlink.app.ui.AuthActivity.getRole(requireContext())
        if (role == "admin") {
            binding.moreAdmin.visibility = View.VISIBLE
            binding.moreAdmin.setOnClickListener {
                navigateTo(AdminFragment.newInstance())
            }
        }

        // Logout - clear username and restart app to username dialog
        binding.moreLogout.setOnClickListener {
            android.app.AlertDialog.Builder(requireContext())
                .setTitle("Logout")
                .setMessage("Log out and change username?")
                .setPositiveButton("Logout") { _, _ ->
                    // Clear auth token and username
                    com.flowlink.app.ui.AuthActivity.logout(requireContext())
                    mainActivity.sessionManager.setUsername("")
                    // Leave session and disconnect
                    mainActivity.leaveSession()
                    // Go to AuthActivity
                    val intent = android.content.Intent(requireContext(), com.flowlink.app.ui.AuthActivity::class.java)
                    intent.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK
                    startActivity(intent)
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    } // end onViewCreated

    private fun navigateTo(fragment: Fragment) {
        parentFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, fragment)
            .addToBackStack(null)
            .commit()
    }

    override fun onResume() {
        super.onResume()
        val unread = InboxFragment.unreadCount(requireContext())
        binding.moreInbox.text = if (unread > 0) "📬   Inbox  ($unread)" else "📬   Inbox"
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
