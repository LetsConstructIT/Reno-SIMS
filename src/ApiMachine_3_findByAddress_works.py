import tkinter as tk
from tkinter import ttk
import requests
import json
import plotly.graph_objects as go

# Function to get data from the API
def get_data_from_api(user_numbers):
    # API endpoint
    api_url = 'https://devkluster.ehr.ee/api/3dtwin/v1/rest-api/particles'
    
    # Headers
    headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    }
    
    # Data to be sent in the POST request
    data = user_numbers  # This should be a list of strings
    
    try:
        # Send POST request
        response = requests.post(api_url, headers=headers, data=json.dumps(data))
        response.raise_for_status()  # Check for HTTP errors
        data = response.json()
        return data
    except requests.exceptions.RequestException as e:
        print(f'Error fetching data from API: {e}')
        return None

# Function to classify surface types
def classify_surface(nz, epsilon=1e-6):
    if nz > epsilon:
        return 'Roof'
    elif nz < -epsilon:
        return 'Floor'
    else:
        return 'Wall'

# Function to visualize the data
def visualize_data(data, treeview):
    # Check if data is a list
    if not isinstance(data, list):
        print('Unexpected data format received from API.')
        return
    
    # Initialize lists for coordinates and indices per surface type
    coords = {'Roof': {'x': [], 'y': [], 'z': [], 'i': [], 'j': [], 'k': []},
              'Wall': {'x': [], 'y': [], 'z': [], 'i': [], 'j': [], 'k': []},
              'Floor': {'x': [], 'y': [], 'z': [], 'i': [], 'j': [], 'k': []}}

    colors = {'Roof': 'red', 'Wall': 'gray', 'Floor': 'green'}

    surface_info_list = []

    for building_data in data:
        building_id = building_data.get('ehr', 'Unknown')
        particles = building_data.get('particles', [])
        
        for idx, particle in enumerate(particles):
            # Get the normal z component
            nz = particle.get('nz', 0)
            area = particle.get('area', 0)
            surface_type = classify_surface(nz)
            
            # Store surface info
            surface_info = {
                'Building ID': building_id,
                'Surface Type': surface_type,
                'Area': area,
                'Index': idx  # To help with indexing
            }
            surface_info_list.append(surface_info)
            
            # Add data to the appropriate surface type
            c = coords[surface_type]
            x0, x1, x2 = particle['x0'], particle['x1'], particle['x2']
            y0, y1, y2 = particle['y0'], particle['y1'], particle['y2']
            z0, z1, z2 = particle['z0'], particle['z1'], particle['z2']
            idx0 = len(c['x'])
            c['x'].extend([x0, x1, x2])
            c['y'].extend([y0, y1, y2])
            c['z'].extend([z0, z1, z2])
            c['i'].append(idx0)
            c['j'].append(idx0 + 1)
            c['k'].append(idx0 + 2)
    
    # Update the Treeview with the surface info
    for i in treeview.get_children():
        treeview.delete(i)
    for surface_info in surface_info_list:
        treeview.insert('', 'end', values=(surface_info['Building ID'], surface_info['Surface Type'], surface_info['Area']))
    
    # Create Mesh3d traces for each surface type
    meshes = []
    for surface_type, c in coords.items():
        if c['x']:  # Only add if there is data
            mesh = go.Mesh3d(
                x=c['x'],
                y=c['y'],
                z=c['z'],
                i=c['i'],
                j=c['j'],
                k=c['k'],
                opacity=0.5,
                color=colors[surface_type],
                name=surface_type,
                showscale=False
            )
            meshes.append(mesh)
    
    if not meshes:
        print('No particle data available to visualize.')
        return
    
    # Create the figure
    fig = go.Figure(data=meshes)
    
    # Adjust layout to hide axes and numbers
    fig.update_layout(
        scene=dict(
            xaxis=dict(visible=False),
            yaxis=dict(visible=False),
            zaxis=dict(visible=False),
        ),
        scene_aspectmode='data',
        margin=dict(r=0, l=0, b=0, t=0),
        legend=dict(title='Surface Types')
    )
    
    # Show the figure
    fig.show()

# Function to sort the Treeview columns
def sortby(tree, col, descending):
    # Get the data to sort
    data = [(tree.set(child, col), child) for child in tree.get_children('')]
    # Convert data to float if sorting by 'Area'
    if col == 'Area':
        data = [(float(item[0]), item[1]) for item in data]
    # Sort the data
    data.sort(reverse=descending)
    # Rearrange items in sorted positions
    for idx, item in enumerate(data):
        tree.move(item[1], '', idx)
    # Reverse sort next time
    tree.heading(col, command=lambda: sortby(tree, col, int(not descending)))

# Function to get building codes from address
def get_building_codes(full_address):
    # API endpoint to get building codes by address
    api_url = 'https://devkluster.ehr.ee/api/geoinfo/v1/getgeoobjectsbyaddress'
    
    # Parameters
    params = {
        'address': full_address
    }
    
    # Headers
    headers = {
        'Accept': 'application/json',
    }
    
    try:
        # Send GET request
        response = requests.get(api_url, headers=headers, params=params)
        response.raise_for_status()
        data = response.json()
        # Extract 'object_code's from the response
        building_codes = []
        for feature in data:
            properties = feature.get('properties', {})
            object_code = properties.get('object_code')
            if object_code:
                building_codes.append(object_code)
        return building_codes
    except requests.exceptions.RequestException as e:
        print(f'Error fetching building codes: {e}')
        return None

# Main function
def main():
    # Create a Tkinter root window
    root = tk.Tk()
    root.title('Building Surface Visualizer')
    
    # Frame for input
    input_frame = tk.Frame(root)
    input_frame.pack(pady=10)
    
    # Label and Combobox for city selection
    tk.Label(input_frame, text='Select City:').grid(row=0, column=0, sticky='e')
    cities = ['Tallinn', 'Tartu', 'Narva', 'Pärnu', 'Kohtla-Järve', 'Viljandi', 'Rakvere', 'Maardu', 'Sillamäe', 'Kuressaare']
    city_var = tk.StringVar()
    city_combobox = ttk.Combobox(input_frame, textvariable=city_var, values=cities, state='readonly')
    city_combobox.grid(row=0, column=1, padx=5, pady=5)
    city_combobox.current(0)  # Set default selection to first city
    
    # Label and Entry for address input
    tk.Label(input_frame, text='Enter Address:').grid(row=1, column=0, sticky='e')
    address_entry = tk.Entry(input_frame, width=50)
    address_entry.grid(row=1, column=1, padx=5, pady=5)
    
    # Frame for Treeview
    tree_frame = tk.Frame(root)
    tree_frame.pack(pady=10)
    
    # Create Treeview
    columns = ('Building ID', 'Surface Type', 'Area')
    treeview = ttk.Treeview(tree_frame, columns=columns, show='headings')
    for col in columns:
        treeview.heading(col, text=col, command=lambda c=col: sortby(treeview, c, False))
        treeview.column(col, width=100)
    treeview.pack(side='left')
    
    # Scrollbar for Treeview
    scrollbar = ttk.Scrollbar(tree_frame, orient='vertical', command=treeview.yview)
    treeview.configure(yscroll=scrollbar.set)
    scrollbar.pack(side='right', fill='y')
    
    # Function to handle button click
    def on_button_click():
        city = city_var.get()
        address = address_entry.get().strip()
        if city and address:
            # Combine city and address
            full_address = f"{city}, {address}"
            building_codes = get_building_codes(full_address)
            if building_codes:
                data = get_data_from_api(building_codes)
                if data:
                    visualize_data(data, treeview)
                else:
                    print('No data received from the API.')
            else:
                print('No buildings found at the specified address.')
        else:
            print('Please select a city and enter an address.')
    
    # Button to trigger data retrieval and visualization
    button = tk.Button(root, text='Visualize', command=on_button_click)
    button.pack(pady=10)
    
    root.mainloop()

if __name__ == '__main__':
    main()
