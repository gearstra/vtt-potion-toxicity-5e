/**
 * Potion Toxicity System for DnD5e in Foundry VTT v12
 */

// Module configuration
const MODULE_ID = "potion-toxicity";
const FLAGS = {
  TOXICITY: "currentToxicity",
  TOXICITY_EFFECTS: "toxicityEffects"
};

// Register module settings
Hooks.once("init", () => {
  // Register module settings
  game.settings.register(MODULE_ID, "toxicityLevels", {
    name: "Toxicity Level Thresholds",
    hint: "Configure level thresholds for toxicity limits",
    scope: "world",
    config: true,
    type: Object,
    default: {
      1: 3,   // Level 1: 3
      4: 4,   // Level 4: 4
      8: 5,   // Level 8: 5
      12: 6,  // Level 12: 6
      16: 7,  // Level 16: 7
      20: 8   // Level 20: 8
    }
  });

  game.settings.register(MODULE_ID, "resetOnLongRest", {
    name: "Reset Toxicity on Long Rest",
    hint: "Automatically reset toxicity to 0 after a long rest",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  
  game.settings.register(MODULE_ID, "toxicityRollTable", {
    name: "Toxicity Effect Roll Table",
    hint: "Name of the roll table to use for toxicity effects",
    scope: "world",
    config: true,
    type: String,
    default: "Toxicity Effects"
  });
});

// Create item sheet hooks to add toxicity field to potions
Hooks.on("renderItemSheet5e", (app, html, data) => {
  if (data.item.type === "consumable" && data.item.system.consumableType === "potion") {
    // Add a toxicity input field to the details tab
    const detailsTab = html.find('.tab[data-tab="details"]');
    const toxicityHTML = `
      <div class="form-group">
        <label>Toxicity Value</label>
        <div class="form-fields">
          <input type="number" name="flags.${MODULE_ID}.toxicityValue" value="${data.item.flags?.[MODULE_ID]?.toxicityValue || 0}">
        </div>
      </div>
    `;
    detailsTab.find(".details").append(toxicityHTML);
  }
});

// Calculate toxicity limit based on character level
function getToxicityLimit(actor) {
  if (!actor || actor.type !== "character") return 3; // Default for non-characters
  
  const level = actor.system.details.level || 1;
  const toxicityLevels = game.settings.get(MODULE_ID, "toxicityLevels");
  
  // Find the highest threshold that is <= the character's level
  const thresholds = Object.keys(toxicityLevels)
    .map(Number)
    .sort((a, b) => a - b);
  
  let limit = toxicityLevels[1]; // Default to level 1 value
  for (const threshold of thresholds) {
    if (level >= threshold) {
      limit = toxicityLevels[threshold];
    } else {
      break;
    }
  }
  
  return limit;
}

// Get current toxicity for an actor
function getCurrentToxicity(actor) {
  return actor.getFlag(MODULE_ID, FLAGS.TOXICITY) || 0;
}

// Set toxicity for an actor
async function setToxicity(actor, value) {
  return await actor.setFlag(MODULE_ID, FLAGS.TOXICITY, value);
}

// Display toxicity information in character sheet
Hooks.on("renderActorSheet5e", (app, html, data) => {
  if (data.actor.type !== "character") return;
  
  const toxicity = getCurrentToxicity(data.actor);
  const toxicityLimit = getToxicityLimit(data.actor);
  
  const resourcesDiv = html.find('.resources');
  const toxicityHTML = `
    <div class="resource">
      <h4 class="box-title">Toxicity</h4>
      <div class="resource-content flexrow flex-center flex-between">
        <span>${toxicity} / ${toxicityLimit}</span>
      </div>
    </div>
  `;
  resourcesDiv.append(toxicityHTML);
});

// Hook into item usage to handle potion consumption
Hooks.on("dnd5e.useItem", async (item, config, options) => {
  if (item.type !== "consumable" || item.system.consumableType !== "potion") return;
  
  const toxicityValue = item.getFlag(MODULE_ID, "toxicityValue") || 0;
  if (toxicityValue <= 0) return;
  
  const actor = item.parent;
  if (!actor || actor.type !== "character") return;
  
  // Add toxicity
  const currentToxicity = getCurrentToxicity(actor);
  const newToxicity = currentToxicity + toxicityValue;
  await setToxicity(actor, newToxicity);
  
  // Display message
  ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<em>${actor.name} consumed a potion, increasing toxicity to ${newToxicity}.</em>`
  });
  
  // Check if toxicity limit is exceeded
  const toxicityLimit = getToxicityLimit(actor);
  if (newToxicity > toxicityLimit) {
    const excess = newToxicity - toxicityLimit;
    await handleToxicityOverflow(actor, excess);
  }
});

// Handle toxicity limit overflow
async function handleToxicityOverflow(actor, excess) {
  // Roll for toxicity effect (1d10 + excess)
  const roll = await new Roll("1d10 + @excess", { excess }).evaluate();
  
  // Show roll to chat
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: "Toxicity Overflow Check"
  });
  
  const total = roll.total;
  
  // Get the roll table
  const tableName = game.settings.get(MODULE_ID, "toxicityRollTable");
  const table = game.tables.getName(tableName);
  
  if (!table) {
    ui.notifications.warn(`Roll table "${tableName}" not found. Check module settings.`);
    return;
  }
  
  // Determine which effect to apply based on the roll
  let formula = "";
  let effect = "";
  
  if (total <= 3) {
    effect = "Geringes Unbehagen";
    formula = "Minor discomfort, no mechanical effect";
  } else if (total === 4) {
    effect = "Leichte Beeinträchtigung";
    formula = "-1 to ability checks and attack rolls for 1 hour";
    // Apply effect
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      label: "Leichte Beeinträchtigung",
      icon: "icons/svg/poison.svg",
      changes: [
        { key: "system.bonuses.abilities.check", mode: 2, value: "-1" },
        { key: "system.bonuses.weapon.attack", mode: 2, value: "-1" }
      ],
      duration: { seconds: 3600 } // 1 hour in seconds
    }]);
  } else if (total <= 7) {
    effect = "Mäßige Vergiftung";
    formula = "Poisoned condition + 1d6 poison damage";
    // Apply poisoned condition
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      label: "Poisoned",
      icon: "icons/svg/poison.svg",
      statuses: ["poisoned"],
      duration: { rounds: 1 }
    }]);
    // Apply damage
    const damageRoll = await new Roll("1d6").evaluate();
    await damageRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: "Poison Damage from Toxicity"
    });
    await actor.applyDamage(damageRoll.total, { damageType: "poison" });
  } else if (total <= 9) {
    effect = "Schwere Reaktion";
    formula = "Incapacitated for 1 round + 2d6 poison damage + poisoned";
    // Apply incapacitated and poisoned
    await actor.createEmbeddedDocuments("ActiveEffect", [
      {
        label: "Incapacitated",
        icon: "icons/svg/paralysis.svg",
        statuses: ["incapacitated"],
        duration: { rounds: 1 }
      },
      {
        label: "Poisoned",
        icon: "icons/svg/poison.svg",
        statuses: ["poisoned"],
        duration: { rounds: 1 }
      }
    ]);
    // Apply damage
    const damageRoll = await new Roll("2d6").evaluate();
    await damageRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: "Poison Damage from Toxicity"
    });
    await actor.applyDamage(damageRoll.total, { damageType: "poison" });
  } else if (total <= 11) {
    effect = "Kritische Beeinträchtigung";
    formula = "Unconscious + prone + poisoned + 3d6 poison damage for 1 round";
    // Apply conditions
    await actor.createEmbeddedDocuments("ActiveEffect", [
      {
        label: "Unconscious",
        icon: "icons/svg/unconscious.svg",
        statuses: ["unconscious"],
        duration: { rounds: 1 }
      },
      {
        label: "Prone",
        icon: "icons/svg/falling.svg",
        statuses: ["prone"],
        duration: { rounds: 1 }
      },
      {
        label: "Poisoned",
        icon: "icons/svg/poison.svg",
        statuses: ["poisoned"],
        duration: { rounds: 1 }
      }
    ]);
    // Apply damage
    const damageRoll = await new Roll("3d6").evaluate();
    await damageRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: "Poison Damage from Toxicity"
    });
    await actor.applyDamage(damageRoll.total, { damageType: "poison" });
  } else {
    effect = "Katastrophale Überdosierung";
    formula = "Comatose (unconscious) + poisoned + 3d6 poison damage";
    // Apply conditions (indefinite duration for coma)
    await actor.createEmbeddedDocuments("ActiveEffect", [
      {
        label: "Comatose",
        icon: "icons/svg/unconscious.svg",
        statuses: ["unconscious"]
        // No duration for indefinite effect
      },
      {
        label: "Poisoned",
        icon: "icons/svg/poison.svg",
        statuses: ["poisoned"]
        // No duration for indefinite effect
      }
    ]);
    // Apply damage
    const damageRoll = await new Roll("3d6").evaluate();
    await damageRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: "Poison Damage from Toxicity"
    });
    await actor.applyDamage(damageRoll.total, { damageType: "poison" });
  }
  
  // Use the roll table to display the result
  await table.draw({ roll, displayChat: true });
  
  // Send chat message about toxicity effect
  ChatMessage.create({
    user: game.user.id,
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<h3>Toxicity Overflow!</h3>
              <p><strong>Result (${total}):</strong> ${effect}</p>
              <p><em>${formula}</em></p>`
  });
}

// Reset toxicity on long rest
Hooks.on("dnd5e.restCompleted", async (actor, restData) => {
  if (!game.settings.get(MODULE_ID, "resetOnLongRest")) return;
  if (restData.longRest) {
    await setToxicity(actor, 0);
    ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<em>${actor.name}'s toxicity has been reset after a long rest.</em>`
    });
  }
});

// Add macro for manually adjusting toxicity
Hooks.once("ready", () => {
  game.PotionToxicity = {
    getToxicityLimit,
    getCurrentToxicity,
    setToxicity,
    handleToxicityOverflow
  };
});