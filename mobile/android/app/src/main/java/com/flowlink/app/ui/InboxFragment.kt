package com.flowlink.app.ui

import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentInboxBinding
import com.flowlink.app.model.Friend
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class InboxItem(
    val id: String,
    val type: String,           // "friend_request" | "sos" | "info"
    val title: String,
    val body: String,
    val fromUsername: String = "",
    val fromDeviceId: String = "",
    val fromDeviceName: String = "",
    val timestamp: Long = System.currentTimeMillis(),
    var handled: Boolean = false
)

class InboxFragment : Fragment() {
    private var _binding: FragmentInboxBinding? = null
    private val binding get() = _binding!!
    private val items = mutableListOf<InboxItem>()
    private var adapter: InboxAdapter? = null

    companion object {
        private const val PREFS_KEY = "flowlink_inbox"
        fun newInstance() = InboxFragment()

        fun addItem(ctx: Context, item: InboxItem) {
            val prefs = ctx.getSharedPreferences(PREFS_KEY, Context.MODE_PRIVATE)
            val list = loadItems(ctx).toMutableList()
            list.add(0, item)
            // Keep last 50
            prefs.edit().putString("items", Gson().toJson(list.take(50))).apply()
        }

        fun loadItems(ctx: Context): List<InboxItem> {
            val prefs = ctx.getSharedPreferences(PREFS_KEY, Context.MODE_PRIVATE)
            val json = prefs.getString("items", null) ?: return emptyList()
            return try {
                Gson().fromJson(json, object : TypeToken<List<InboxItem>>() {}.type)
            } catch (_: Exception) { emptyList() }
        }

        fun unreadCount(ctx: Context) = loadItems(ctx).count { !it.handled }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentInboxBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return

        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        items.clear()
        items.addAll(loadItems(requireContext()))
        // Mark all as read when inbox is opened
        markAllRead()

        binding.rvInbox.layoutManager = LinearLayoutManager(requireContext())
        adapter = InboxAdapter(
            items = items,
            onAccept = { item ->
                // Accept friend request
                FriendsFragment.saveFriend(requireContext(), Friend(
                    username = item.fromUsername,
                    deviceName = item.fromDeviceName,
                    deviceId = item.fromDeviceId,
                    status = "accepted"
                ))
                mainActivity.webSocketManager.respondFriendRequest(
                    item.fromDeviceId, item.fromUsername, true
                )
                markHandled(item)
                Toast.makeText(requireContext(), "✅ Accepted ${item.fromUsername}", Toast.LENGTH_SHORT).show()
            },
            onDecline = { item ->
                mainActivity.webSocketManager.respondFriendRequest(
                    item.fromDeviceId, item.fromUsername, false
                )
                markHandled(item)
                Toast.makeText(requireContext(), "Declined ${item.fromUsername}", Toast.LENGTH_SHORT).show()
            }
        )
        binding.rvInbox.adapter = adapter
        updateEmptyState()

        // Observe incoming friend requests in real time
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.friendRequestEvents.collect { event ->
                if (event.type == "received") {
                    val newItem = InboxItem(
                        id = "fr-${System.currentTimeMillis()}",
                        type = "friend_request",
                        title = "Friend Request",
                        body = "${event.fromUsername} wants to be your friend",
                        fromUsername = event.fromUsername,
                        fromDeviceId = event.fromDeviceId,
                        fromDeviceName = event.fromDeviceName
                    )
                    addItem(requireContext(), newItem)
                    items.add(0, newItem)
                    adapter?.notifyItemInserted(0)
                    binding.rvInbox.scrollToPosition(0)
                    updateEmptyState()
                }
            }
        }
    }

    private fun markHandled(item: InboxItem) {
        item.handled = true
        val prefs = requireContext().getSharedPreferences(PREFS_KEY, Context.MODE_PRIVATE)
        prefs.edit().putString("items", Gson().toJson(items)).apply()
        adapter?.notifyDataSetChanged()
        updateEmptyState()
    }

    private fun markAllRead() {
        items.forEach { it.handled = true }
        val prefs = requireContext().getSharedPreferences(PREFS_KEY, Context.MODE_PRIVATE)
        prefs.edit().putString("items", Gson().toJson(items)).apply()
    }

    private fun updateEmptyState() {
        val isEmpty = items.isEmpty()
        binding.rvInbox.visibility = if (isEmpty) View.GONE else View.VISIBLE
        binding.llEmpty.visibility = if (isEmpty) View.VISIBLE else View.GONE
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}

class InboxAdapter(
    private val items: MutableList<InboxItem>,
    private val onAccept: (InboxItem) -> Unit,
    private val onDecline: (InboxItem) -> Unit
) : RecyclerView.Adapter<InboxAdapter.InboxVH>() {

    private val timeFmt = SimpleDateFormat("HH:mm", Locale.getDefault())

    class InboxVH(v: View) : RecyclerView.ViewHolder(v) {
        val tvIcon: TextView = v.findViewById(R.id.tv_inbox_icon)
        val tvTitle: TextView = v.findViewById(R.id.tv_inbox_title)
        val tvBody: TextView = v.findViewById(R.id.tv_inbox_body)
        val tvTime: TextView = v.findViewById(R.id.tv_inbox_time)
        val llActions: LinearLayout = v.findViewById(R.id.ll_actions)
        val btnAccept: Button = v.findViewById(R.id.btn_accept)
        val btnDecline: Button = v.findViewById(R.id.btn_decline)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        InboxVH(LayoutInflater.from(parent.context).inflate(R.layout.item_inbox, parent, false))

    override fun onBindViewHolder(holder: InboxVH, position: Int) {
        val item = items[position]
        holder.tvTitle.text = item.title
        holder.tvBody.text = item.body
        holder.tvTime.text = timeFmt.format(Date(item.timestamp))
        holder.tvIcon.text = when (item.type) {
            "friend_request" -> "👤"
            "sos" -> "🆘"
            else -> "📩"
        }
        // Dim handled items
        holder.itemView.alpha = if (item.handled) 0.5f else 1f

        if (item.type == "friend_request" && !item.handled) {
            holder.llActions.visibility = View.VISIBLE
            holder.btnAccept.setOnClickListener { onAccept(item) }
            holder.btnDecline.setOnClickListener { onDecline(item) }
        } else {
            holder.llActions.visibility = View.GONE
        }
    }

    override fun getItemCount() = items.size
}
