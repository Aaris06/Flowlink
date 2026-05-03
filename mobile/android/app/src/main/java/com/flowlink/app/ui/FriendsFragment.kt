package com.flowlink.app.ui

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentFriendsBinding
import com.flowlink.app.model.Friend
import com.flowlink.app.service.WebSocketManager
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import kotlinx.coroutines.launch
import org.json.JSONObject

class FriendsFragment : Fragment() {
    private var _binding: FragmentFriendsBinding? = null
    private val binding get() = _binding!!
    private val friends = mutableListOf<Friend>()
    private var friendsAdapter: FriendsAdapter? = null

    private val requestLocation = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { perms ->
        if (perms[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
            perms[Manifest.permission.ACCESS_COARSE_LOCATION] == true) {
            sendSOS()
        } else {
            Toast.makeText(requireContext(), "Location permission needed for SOS", Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        private const val PREFS_KEY = "flowlink_friends"

        fun newInstance() = FriendsFragment()

        private fun prefsKey(ctx: Context): String {
            val username = AuthActivity.getUsername(ctx).lowercase().trim()
            return if (username.isNotEmpty()) "${PREFS_KEY}_$username" else PREFS_KEY
        }

        /** Save an accepted friend (called after request accepted) */
        fun saveFriend(ctx: Context, friend: Friend) {
            val prefs = ctx.getSharedPreferences(prefsKey(ctx), Context.MODE_PRIVATE)
            val list = loadFriends(ctx).toMutableList()
            list.removeAll { it.deviceId == friend.deviceId }
            list.add(friend.copy(status = "accepted"))
            prefs.edit().putString("list", Gson().toJson(list)).apply()
        }

        /** Save a pending-sent request */
        fun savePendingSent(ctx: Context, friend: Friend) {
            val prefs = ctx.getSharedPreferences(prefsKey(ctx), Context.MODE_PRIVATE)
            val list = loadFriends(ctx).toMutableList()
            if (list.none { it.deviceId == friend.deviceId }) {
                list.add(friend.copy(status = "pending_sent"))
                prefs.edit().putString("list", Gson().toJson(list)).apply()
            }
        }

        /** Remove a friend or pending entry */
        fun removeFriend(ctx: Context, deviceId: String) {
            val prefs = ctx.getSharedPreferences(prefsKey(ctx), Context.MODE_PRIVATE)
            val list = loadFriends(ctx).toMutableList()
            list.removeAll { it.deviceId == deviceId }
            prefs.edit().putString("list", Gson().toJson(list)).apply()
        }

        fun loadFriends(ctx: Context): List<Friend> {
            val prefs = ctx.getSharedPreferences(prefsKey(ctx), Context.MODE_PRIVATE)
            val json = prefs.getString("list", null) ?: return emptyList()
            return try {
                Gson().fromJson(json, object : TypeToken<List<Friend>>() {}.type)
            } catch (_: Exception) { emptyList() }
        }

        fun isFriendOrPending(ctx: Context, deviceId: String): Boolean {
            return loadFriends(ctx).any { it.deviceId == deviceId }
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentFriendsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return

        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        binding.rvFriends.layoutManager = LinearLayoutManager(requireContext())
        friendsAdapter = FriendsAdapter(
            friends = friends,
            onRemove = { friend ->
                AlertDialog.Builder(requireContext())
                    .setTitle("Remove Friend")
                    .setMessage("Remove ${friend.username}?")
                    .setPositiveButton("Remove") { _, _ ->
                        removeFriend(requireContext(), friend.deviceId)
                        loadAndDisplay()
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
        )
        binding.rvFriends.adapter = friendsAdapter

        // Load after adapter is set
        loadAndDisplay()
        updateEmptyState()

        // SOS button
        binding.btnSos.setOnClickListener {
            val accepted = friends.filter { it.status == "accepted" }
            if (accepted.isEmpty()) {
                Toast.makeText(requireContext(), "No accepted friends to send SOS to", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            AlertDialog.Builder(requireContext())
                .setTitle("🆘 Send SOS?")
                .setMessage("Send your location to ${accepted.size} friend(s)?")
                .setPositiveButton("Send SOS") { _, _ -> checkLocationAndSend() }
                .setNegativeButton("Cancel", null)
                .show()
        }

        // Observe friend request events
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.friendRequestEvents.collect { event ->
                when (event.type) {
                    "accepted" -> {
                        // Mark as accepted in storage
                        saveFriend(requireContext(), Friend(
                            username = event.fromUsername,
                            deviceName = event.fromDeviceName,
                            deviceId = event.fromDeviceId,
                            status = "accepted"
                        ))
                        loadAndDisplay()
                        Toast.makeText(requireContext(), "✅ ${event.fromUsername} accepted your request!", Toast.LENGTH_SHORT).show()
                    }
                    "rejected" -> {
                        removeFriend(requireContext(), event.fromDeviceId)
                        loadAndDisplay()
                        Toast.makeText(requireContext(), "${event.fromUsername} declined your request", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    private fun loadAndDisplay() {
        friends.clear()
        friends.addAll(loadFriends(requireContext()))
        friendsAdapter?.notifyDataSetChanged()
        updateEmptyState()
    }

    private fun checkLocationAndSend() {
        val ctx = requireContext()
        val fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (fine || coarse) sendSOS()
        else requestLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private fun sendSOS() {
        val ctx = requireContext()
        val mainActivity = activity as? MainActivity ?: return
        try {
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            val location = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            val lat = location?.latitude ?: 0.0
            val lng = location?.longitude ?: 0.0
            val mapsUrl = "https://maps.google.com/?q=$lat,$lng"
            val acceptedIds = friends.filter { it.status == "accepted" }.map { it.deviceId }
            mainActivity.webSocketManager.sendSosToDevices(acceptedIds, lat, lng, mapsUrl)
            Toast.makeText(ctx, "🆘 SOS sent to ${acceptedIds.size} friend(s)!", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(ctx, "SOS failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun updateEmptyState() {
        val isEmpty = friends.isEmpty()
        binding.rvFriends.visibility = if (isEmpty) View.GONE else View.VISIBLE
        binding.llEmpty.visibility = if (isEmpty) View.VISIBLE else View.GONE
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}

class FriendsAdapter(
    private val friends: MutableList<Friend>,
    private val onRemove: (Friend) -> Unit
) : RecyclerView.Adapter<FriendsAdapter.FriendVH>() {

    class FriendVH(v: View) : RecyclerView.ViewHolder(v) {
        val tvInitial: TextView = v.findViewById(R.id.tv_friend_initial)
        val tvUsername: TextView = v.findViewById(R.id.tv_friend_username)
        val tvDevice: TextView = v.findViewById(R.id.tv_friend_device)
        val btnRemove: ImageButton = v.findViewById(R.id.btn_remove_friend)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        FriendVH(LayoutInflater.from(parent.context).inflate(R.layout.item_friend, parent, false))

    override fun onBindViewHolder(holder: FriendVH, position: Int) {
        val f = friends[position]
        holder.tvInitial.text = f.username.firstOrNull()?.uppercaseChar()?.toString() ?: "U"
        holder.tvUsername.text = f.username
        holder.tvDevice.text = when (f.status) {
            "pending_sent" -> "⏳ Request sent"
            "pending_received" -> "📩 Wants to connect"
            else -> f.deviceName
        }
        holder.btnRemove.setOnClickListener { onRemove(f) }
    }

    override fun getItemCount() = friends.size
}
