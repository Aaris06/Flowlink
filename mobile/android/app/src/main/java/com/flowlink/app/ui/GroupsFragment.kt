package com.flowlink.app.ui

import android.app.AlertDialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentGroupsBinding
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.launch

class GroupsFragment : Fragment() {
    private var _binding: FragmentGroupsBinding? = null
    private val binding get() = _binding!!
    private var groupsAdapter: GroupsAdapter? = null

    companion object {
        fun newInstance() = GroupsFragment()
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentGroupsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return

        binding.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }

        binding.rvGroups.layoutManager = LinearLayoutManager(requireContext())
        groupsAdapter = GroupsAdapter(
            groups = mutableListOf(),
            onDelete = { group ->
                mainActivity.webSocketManager.deleteGroup(group.id)
                Toast.makeText(requireContext(), "Deleted ${group.name}", Toast.LENGTH_SHORT).show()
            }
        )
        binding.rvGroups.adapter = groupsAdapter

        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.groups.collect { groups ->
                if (groups.isEmpty()) {
                    binding.tvGroupsEmpty.visibility = View.VISIBLE
                    binding.rvGroups.visibility = View.GONE
                } else {
                    binding.tvGroupsEmpty.visibility = View.GONE
                    binding.rvGroups.visibility = View.VISIBLE
                    groupsAdapter?.setGroups(groups)
                }
            }
        }

        binding.btnCreateGroup.setOnClickListener { showCreateGroupDialog(mainActivity) }
    }

    private fun showCreateGroupDialog(mainActivity: MainActivity) {
        val devices = mainActivity.webSocketManager.sessionDevices.value
        if (devices.isEmpty()) {
            Toast.makeText(requireContext(), "No devices connected", Toast.LENGTH_SHORT).show()
            return
        }
        val ctx = requireContext()
        val dialogView = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 32, 48, 16)
        }
        val etName = EditText(ctx).apply {
            hint = "Group name"
            setTextColor(android.graphics.Color.WHITE)
            setHintTextColor(android.graphics.Color.GRAY)
        }
        dialogView.addView(etName)
        val checkboxes = devices.map { device ->
            android.widget.CheckBox(ctx).apply {
                text = device.name
                setTextColor(android.graphics.Color.WHITE)
                isChecked = true
            }.also { dialogView.addView(it) }
        }
        AlertDialog.Builder(ctx)
            .setTitle("Create Group")
            .setView(dialogView)
            .setPositiveButton("Create") { _, _ ->
                val name = etName.text.toString().trim()
                if (name.isEmpty()) { Toast.makeText(ctx, "Enter a group name", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                val selectedIds = devices.filterIndexed { i, _ -> checkboxes[i].isChecked }.map { it.id }
                if (selectedIds.isEmpty()) { Toast.makeText(ctx, "Select at least one device", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                mainActivity.webSocketManager.createGroup(name, selectedIds)
                Toast.makeText(ctx, "Group '$name' created", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}

class GroupsAdapter(
    private val groups: MutableList<WebSocketManager.GroupInfo>,
    private val onDelete: (WebSocketManager.GroupInfo) -> Unit
) : RecyclerView.Adapter<GroupsAdapter.GroupViewHolder>() {

    class GroupViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val tvName: TextView = itemView.findViewById(R.id.tv_group_name)
        val tvCount: TextView = itemView.findViewById(R.id.tv_group_count)
        val btnDelete: View = itemView.findViewById(R.id.btn_delete_group)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): GroupViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_group, parent, false)
        return GroupViewHolder(view)
    }

    override fun onBindViewHolder(holder: GroupViewHolder, position: Int) {
        val group = groups[position]
        holder.tvName.text = group.name
        holder.tvCount.text = "${group.deviceIds.size} device(s)"
        holder.btnDelete.setOnClickListener { onDelete(group) }
    }

    override fun getItemCount() = groups.size

    fun setGroups(newGroups: List<WebSocketManager.GroupInfo>) {
        groups.clear()
        groups.addAll(newGroups)
        notifyDataSetChanged()
    }
}
