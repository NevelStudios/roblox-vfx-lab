--!strict
-- Studio side of the lab. studio.js sends this file with every execute_luau call through Roblox's Studio MCP, then
-- `return run("<op>", <json args>)`. Writes are all-or-nothing: every path and value is resolved before the first
-- write, and a failure mid-write restores what was already changed.

local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")

local function fail(message: string): never
	error("vfx-lab: " .. message, 0)
end

-- "Workspace.Map.Door" or { "Workspace", "Name.With.Dots" }.
local function resolve(path: any): Instance
	local segments: { string } = if type(path) == "table" then path else string.split(tostring(path), ".")
	if #segments == 0 or segments[1] == "" then fail(`empty path`) end
	local ok, service = pcall(game.GetService, game, segments[1])
	local current: Instance = if ok and service then service else fail(`{segments[1]} is not a service`)
	for index = 2, #segments do
		local child = current:FindFirstChild(segments[index])
		if child == nil then fail(`{table.concat(segments, ".", 1, index)} not found`) end
		current = child
	end
	return current
end

local function resolveAll(paths: any): { Instance }
	if type(paths) ~= "table" or #paths == 0 then fail("paths must be a non-empty array") end
	local out = {}
	for _, path in paths do
		table.insert(out, resolve(path))
	end
	return out
end

local function hex(color: Color3): string
	return "#" .. color:ToHex()
end

-- Roblox value -> JSON-safe value. Plain JSON for primitives, { ["$type"] = ..., value = ... } for datatypes.
local function encode(value: any): any
	local kind = typeof(value)
	if kind == "nil" or kind == "boolean" or kind == "number" or kind == "string" then return value end
	local function tagged(v: any) return { ["$type"] = kind, value = v } end
	if kind == "Vector3" then return tagged({ value.X, value.Y, value.Z }) end
	if kind == "Vector2" then return tagged({ value.X, value.Y }) end
	if kind == "Color3" then return tagged(hex(value)) end
	if kind == "UDim2" then return tagged({ value.X.Scale, value.X.Offset, value.Y.Scale, value.Y.Offset }) end
	if kind == "UDim" then return tagged({ value.Scale, value.Offset }) end
	if kind == "CFrame" then return tagged({ value:GetComponents() }) end
	if kind == "EnumItem" then return { ["$type"] = "Enum", value = tostring(value) } end
	if kind == "BrickColor" then return tagged(value.Name) end
	if kind == "Instance" then return tagged(value:GetFullName()) end
	if kind == "NumberRange" then return tagged({ value.Min, value.Max }) end
	if kind == "Rect" then return tagged({ value.Min.X, value.Min.Y, value.Max.X, value.Max.Y }) end
	if kind == "Font" then return tagged({ family = value.Family, weight = value.Weight.Name, style = value.Style.Name }) end
	if kind == "ColorSequence" then
		local keys = {}
		for _, key in value.Keypoints do
			table.insert(keys, { key.Time, hex(key.Value) })
		end
		return tagged(keys)
	end
	if kind == "NumberSequence" then
		local keys = {}
		for _, key in value.Keypoints do
			table.insert(keys, { key.Time, key.Value, key.Envelope })
		end
		return tagged(keys)
	end
	return { ["$type"] = kind, text = tostring(value) }
end

local function numbers(value: any, count: number, label: string): { number }
	if type(value) ~= "table" or #value ~= count then fail(`{label} needs {count} numbers`) end
	for _, n in value do
		if type(n) ~= "number" then fail(`{label} needs {count} numbers`) end
	end
	return value
end

local function color(value: any): Color3
	if type(value) == "string" then
		local ok, result = pcall(Color3.fromHex, value)
		if ok then return result end
		fail(`bad color {value}`)
	end
	local n = numbers(value, 3, "Color3")
	return Color3.fromRGB(n[1], n[2], n[3])
end

-- JSON value -> Roblox value. `kind` is the explicit $type or, when absent, the property's current type, so
-- { Size = { 4, 1, 2 } } works on a Part without tagging.
local function decode(spec: any, currentKind: string?): any
	local kind = currentKind
	local value = spec
	if type(spec) == "table" and spec["$type"] ~= nil then
		kind = spec["$type"]
		value = spec.value
	end
	if kind == nil or kind == "nil" or kind == "string" or kind == "number" or kind == "boolean" then
		if type(value) == "table" then fail(`a table value needs a "$type"`) end
		return value
	end
	if kind == "Vector3" then
		local n = numbers(value, 3, kind)
		return Vector3.new(n[1], n[2], n[3])
	end
	if kind == "Vector2" then
		local n = numbers(value, 2, kind)
		return Vector2.new(n[1], n[2])
	end
	if kind == "Color3" then return color(value) end
	if kind == "UDim2" then
		local n = numbers(value, 4, kind)
		return UDim2.new(n[1], n[2], n[3], n[4])
	end
	if kind == "UDim" then
		local n = numbers(value, 2, kind)
		return UDim.new(n[1], n[2])
	end
	if kind == "CFrame" then
		if type(value) == "table" and #value == 3 then return CFrame.new(value[1], value[2], value[3]) end
		local n = numbers(value, 12, kind)
		return CFrame.new(table.unpack(n))
	end
	if kind == "Enum" or kind == "EnumItem" then
		if type(value) ~= "string" then fail("an Enum value is a string like Enum.Material.Neon or Neon") end
		local parts = string.split(value, ".")
		if #parts == 3 and parts[1] == "Enum" then return (Enum :: any)[parts[2]][parts[3]] end
		return value -- a bare item name; Roblox coerces it on assignment to an enum property
	end
	if kind == "BrickColor" then return BrickColor.new(value) end
	if kind == "Instance" then return resolve(value) end
	if kind == "NumberRange" then
		local n = numbers(value, 2, kind)
		return NumberRange.new(n[1], n[2])
	end
	if kind == "Font" then
		if type(value) == "string" then return Font.fromName(value) end
		local family = value.family or fail("Font needs family")
		local weight = if value.weight then (Enum.FontWeight :: any)[value.weight] else Enum.FontWeight.Regular
		local style = if value.style then (Enum.FontStyle :: any)[value.style] else Enum.FontStyle.Normal
		return Font.new(family, weight, style)
	end
	if kind == "ColorSequence" then
		if type(value) == "string" or (type(value) == "table" and type(value[1]) == "number") then
			return ColorSequence.new(color(value))
		end
		local keys = {}
		for _, key in value do
			table.insert(keys, ColorSequenceKeypoint.new(key[1], color(key[2])))
		end
		return ColorSequence.new(keys)
	end
	if kind == "NumberSequence" then
		if type(value) == "number" then return NumberSequence.new(value) end
		local keys = {}
		for _, key in value do
			table.insert(keys, NumberSequenceKeypoint.new(key[1], key[2], key[3] or 0))
		end
		return NumberSequence.new(keys)
	end
	fail(`cannot build a {kind} from JSON`)
end

local function readProperty(instance: Instance, name: string): (boolean, any)
	return pcall(function() return (instance :: any)[name] end)
end

-- Every (instance, property, value) the batch will write, decoded against the current type before any write.
local function planWrites(instances: { Instance }, properties: any): { { instance: Instance, name: string, value: any } }
	if type(properties) ~= "table" or next(properties) == nil then fail("properties must be a non-empty object") end
	local plan = {}
	for _, instance in instances do
		for name, spec in properties do
			if name == "Parent" then fail("use move_instances to change Parent") end
			local ok, current = readProperty(instance, name)
			if not ok then fail(`{instance:GetFullName()} has no readable property {name}`) end
			local decoded, value = pcall(decode, spec, typeof(current))
			if not decoded then fail(`{instance:GetFullName()}.{name}: {string.gsub(tostring(value), "^vfx%-lab: ", "")}`) end
			table.insert(plan, { instance = instance, name = name, value = value })
		end
	end
	return plan
end

-- Applies a plan; on the first failure restores every value already written and raises.
local function applyWrites(plan: { { instance: Instance, name: string, value: any } })
	local done = {}
	for _, write in plan do
		local _, old = readProperty(write.instance, write.name)
		local ok, err = pcall(function() (write.instance :: any)[write.name] = write.value end)
		if not ok then
			local unrestored = {}
			for index = #done, 1, -1 do
				local undo = done[index]
				local restored, restoreErr = pcall(function() (undo.instance :: any)[undo.name] = undo.old end)
				if not restored then
					table.insert(unrestored, `{undo.instance:GetFullName()}.{undo.name} ({restoreErr})`)
				end
			end
			local status = if #unrestored == 0 then "batch restored" else "NOT restored: " .. table.concat(unrestored, ", ")
			fail(`{write.instance:GetFullName()}.{write.name}: {err} ({status})`)
		end
		table.insert(done, { instance = write.instance, name = write.name, old = old })
	end
end

local function attributeValue(spec: any): any
	if type(spec) == "table" and spec["$type"] == nil then fail("attribute tables need a \"$type\"") end
	return decode(spec, nil)
end

local ops = {}

function ops.get_properties(args: any)
	local out = {}
	for index, instance in resolveAll(args.paths) do
		local values = {}
		for _, name in args.properties or fail("properties must be an array of names") do
			local ok, value = readProperty(instance, name)
			values[name] = if ok then encode(value) else { ["$error"] = tostring(value) }
		end
		out[index] = { path = instance:GetFullName(), className = instance.ClassName, values = values }
	end
	return out
end

function ops.set_properties(args: any)
	local plan = planWrites(resolveAll(args.paths), args.properties)
	applyWrites(plan)
	return { written = #plan }
end

-- Builds one item (and its children) unparented. Returns the root and the plan of property writes for it.
local function build(item: any, plan: { any }): Instance
	if type(item) ~= "table" or type(item.className) ~= "string" then fail("every item needs a className") end
	local ok, instance = pcall(Instance.new, item.className)
	if not ok then fail(`cannot create {item.className}: {instance}`) end
	if item.name then instance.Name = item.name end
	if item.properties then
		for _, write in planWrites({ instance }, item.properties) do
			table.insert(plan, write)
		end
	end
	for name, spec in item.attributes or {} do
		instance:SetAttribute(name, attributeValue(spec))
	end
	for _, tag in item.tags or {} do
		CollectionService:AddTag(instance, tag)
	end
	for _, child in item.children or {} do
		build(child, plan).Parent = instance
	end
	return instance
end

function ops.create_instances(args: any)
	if type(args.items) ~= "table" or #args.items == 0 then fail("items must be a non-empty array") end
	local roots: { { instance: Instance, parent: Instance } } = {}
	local ok, err = pcall(function()
		local plan = {}
		for _, item in args.items do
			local parent = resolve(item.parent or fail("every top-level item needs a parent"))
			table.insert(roots, { instance = build(item, plan), parent = parent })
		end
		applyWrites(plan)
	end)
	if not ok then
		for _, root in roots do
			root.instance:Destroy()
		end
		error(err, 0)
	end
	local created = {}
	for _, root in roots do
		root.instance.Parent = root.parent -- Parent last, after every property is set
		table.insert(created, root.instance:GetFullName())
	end
	return { created = created }
end

-- VFX preview (lab.js vfx_preview): every ParticleEmitter at or under the targets, in a stable order, so a later call can hand
-- back the TimeScales an earlier one read.
local function vfxEmitters(targets: any): { ParticleEmitter }
	local found = {}
	for _, root in resolveAll(targets) do
		if root:IsA("ParticleEmitter") then table.insert(found, root) end
		for _, item in root:GetDescendants() do
			if item:IsA("ParticleEmitter") then table.insert(found, item) end
		end
	end
	if #found == 0 then fail("no ParticleEmitter at or under the targets") end
	return found
end

local function vfxPosition(emitter: ParticleEmitter): Vector3
	local parent = emitter.Parent
	if parent and parent:IsA("Attachment") then return parent.WorldPosition end
	if parent and parent:IsA("BasePart") then return parent.Position end
	fail(`{emitter:GetFullName()} is not under a BasePart or an Attachment`)
end

-- Plays the emitters from empty (EmitCount and EmitDelay attributes honoured for bursts), waits `at` seconds, then
-- freezes them (TimeScale 0) so a screen capture sees that moment. Answers the TimeScales to restore and a camera.
function ops.vfx_freeze(args: any)
	local emitters = vfxEmitters(args.targets)
	local at = tonumber(args.at) or fail("at (seconds) is required")
	-- A texture that has not loaded yet draws nothing (a fresh upload, a first preview): wait for every one first.
	game:GetService("ContentProvider"):PreloadAsync(emitters)
	local timeScales = {}
	for index, emitter in emitters do
		timeScales[index] = if type(args.timeScales) == "table" then args.timeScales[index] else emitter.TimeScale
		emitter.TimeScale = timeScales[index]
		emitter:Clear()
	end
	for _, emitter in emitters do
		local count = tonumber(args.emit) or tonumber(emitter:GetAttribute("EmitCount")) or 1
		local delay = tonumber(emitter:GetAttribute("EmitDelay")) or 0
		if not emitter.Enabled and delay <= at then
			if delay > 0 then
				task.delay(delay, function()
					emitter:Emit(count)
				end)
			else
				emitter:Emit(count)
			end
		end
	end
	task.wait(at)
	local sum, reach = Vector3.zero, 2
	for _, emitter in emitters do
		emitter.TimeScale = 0
		sum += vfxPosition(emitter)
	end
	local centre = sum / #emitters
	for _, emitter in emitters do
		local size = 0
		for _, key in emitter.Size.Keypoints do
			size = math.max(size, key.Value + key.Envelope)
		end
		local travel = emitter.Speed.Max * emitter.Lifetime.Max * 0.5
		reach = math.max(reach, (vfxPosition(emitter) - centre).Magnitude + size / 2 + travel)
	end
	local camera = centre + Vector3.new(0.55, 0.35, 1).Unit * reach * 2.4
	return {
		emitters = #emitters,
		timeScales = timeScales,
		focus = { centre.X, centre.Y, centre.Z },
		camera = { camera.X, camera.Y, camera.Z },
	}
end

function ops.vfx_restore(args: any)
	local emitters = vfxEmitters(args.targets)
	for index, emitter in emitters do
		emitter.TimeScale = tonumber(args.timeScales[index]) or emitter.TimeScale
		emitter:Clear()
	end
	return { restored = #emitters }
end

-- Export to Roblox (server.js): where the Studio selection takes a texture. Instances that wear one are targets;
-- else the first selected BasePart or Attachment is the parent of a new emitter. Paths are names from the service down.
local TEXTURED = { "ParticleEmitter", "Beam", "Trail", "Decal", "Texture", "MeshPart" }

local function pathOf(instance: Instance): { string }
	local names = {}
	local current: Instance? = instance
	while current and current ~= game do
		table.insert(names, 1, current.Name)
		current = current.Parent
	end
	return names
end

function ops.vfx_selection(_args: any)
	local selected = game:GetService("Selection"):Get()
	local targets = {}
	for _, item in selected do
		for _, className in TEXTURED do
			if item:IsA(className) then
				table.insert(targets, { path = pathOf(item), className = item.ClassName })
				break
			end
		end
	end
	local parent = nil
	if #targets == 0 then
		for _, item in selected do
			if item:IsA("BasePart") or item:IsA("Attachment") then
				parent = pathOf(item)
				break
			end
		end
	end
	return { targets = targets, parent = parent }
end

local function run(op: string, json: string): string
	local handler = (ops :: any)[op] or fail(`unknown op {op}`)
	return HttpService:JSONEncode(handler(HttpService:JSONDecode(json)))
end
